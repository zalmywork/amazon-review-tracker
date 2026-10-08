import { db, must } from "./db";
import { recordEvents } from "./events";
import {
  CATALOG_BATCH,
  CATALOG_PAUSE_MS,
  getCatalogItems,
  marketplaceId,
  type CatalogItem,
} from "./spapi";
import { sleep } from "./time";
import type { AsinRow, EventRow } from "./types";

/**
 * Daily family check against Amazon's catalog: which parent each variation
 * sits under, and which children each parent lists. Comparing that with
 * yesterday is how we catch a variation being split off its family.
 */

interface Family {
  title: string | null;
  brand: string | null;
  image_url: string | null;
  variation_label: string | null;
  item_classification: string | null;
  parent_asin: string | null;
  child_asins: string[];
  variation_theme: string | null;
  is_parent: boolean;
}

function forMarket<T extends { marketplaceId: string }>(groups: T[] | undefined): T | undefined {
  return groups?.find((g) => g.marketplaceId === marketplaceId()) ?? groups?.[0];
}

export function parse(item: CatalogItem): Family {
  const summary = forMarket(item.summaries);
  const images = forMarket(item.images)?.images ?? [];
  const mains = images.filter((i) => i.variant === "MAIN");
  const pool = (mains.length ? mains : images).slice().sort((a, b) => a.width - b.width);
  // Emails show a small thumbnail: take the smallest image that's still crisp.
  const image = pool.find((i) => i.width >= 100) ?? pool.at(-1);

  let parent: string | null = null;
  let children: string[] = [];
  let theme: string | null = null;
  for (const rel of forMarket(item.relationships)?.relationships ?? []) {
    if (rel.type !== "VARIATION") continue;
    if (rel.parentAsins?.length) parent = rel.parentAsins[0].toUpperCase();
    if (rel.childAsins?.length) children = rel.childAsins.map((c) => c.toUpperCase());
    theme = rel.variationTheme?.theme ?? theme;
  }
  const label = [summary?.color, summary?.size, summary?.style].filter(Boolean).join(" / ");
  return {
    title: summary?.itemName ?? null,
    brand: summary?.brand ?? null,
    image_url: image?.link ?? null,
    variation_label: label || null,
    item_classification: summary?.itemClassification ?? null,
    parent_asin: parent,
    child_asins: [...new Set(children)].sort(),
    variation_theme: theme,
    is_parent: children.length > 0 || summary?.itemClassification === "VARIATION_PARENT",
  };
}

function removedChildren(row: AsinRow, now: Family): string[] {
  const current = new Set(now.child_asins);
  return row.child_asins.filter((c) => !current.has(c));
}

function changed(row: AsinRow, now: Family): boolean {
  return row.parent_asin !== now.parent_asin || removedChildren(row, now).length > 0;
}

/** A variation's own parent changed (or vanished) since `oldParent` was recorded. */
function parentChange(
  asin: string,
  oldParent: string | null,
  newParent: string | null,
  today: string,
  extra: EventRow["details"] = {}
): EventRow | null {
  if (oldParent && !newParent) {
    return { detected_on: today, type: "left_family", asin, family_asin: oldParent, details: { old_parent: oldParent, ...extra } };
  }
  if (oldParent && newParent && oldParent !== newParent) {
    return {
      detected_on: today,
      type: "moved_family",
      asin,
      family_asin: oldParent,
      details: { old_parent: oldParent, new_parent: newParent, ...extra },
    };
  }
  return null;
}

export interface RemovedChild {
  child: string;
  parent: string;
  dissolved: boolean;
}

/**
 * Changes seen from this ASIN's own record. Children missing from a parent's
 * list are returned separately: they're only reported once the child's own
 * record confirms it left (see verifyRemoved), so a truncated child list
 * can't trigger a false alarm.
 */
export function diff(row: AsinRow, now: Family, today: string): { events: EventRow[]; removed: RemovedChild[] } {
  const events: EventRow[] = [];
  const own = parentChange(row.asin, row.parent_asin, now.parent_asin, today, { source: "child" });
  if (own) events.push(own);
  else if (!row.parent_asin && now.parent_asin && row.ever_in_family) {
    events.push({
      detected_on: today,
      type: "joined_family",
      asin: row.asin,
      family_asin: now.parent_asin,
      details: { new_parent: now.parent_asin },
    });
  }
  const dissolved = row.child_asins.length > 0 && now.child_asins.length === 0;
  const removed = removedChildren(row, now).map((child) => ({ child, parent: row.asin, dissolved }));
  return { events, removed };
}

/** Look each dropped child up directly; alert only if it really left (or is gone from the catalog). */
async function verifyRemoved(
  removed: RemovedChild[],
  today: string,
  log: (m: string) => void
): Promise<EventRow[]> {
  const events: EventRow[] = [];
  for (let i = 0; i < removed.length; i += CATALOG_BATCH) {
    const batch = removed.slice(i, i + CATALOG_BATCH);
    await sleep(CATALOG_PAUSE_MS);
    const items = await getCatalogItems(batch.map((r) => r.child));
    const byAsin = new Map(items.map((it) => [it.asin.toUpperCase(), it]));
    for (const r of batch) {
      const item = byAsin.get(r.child);
      const extra = { source: "parent" as const, family_dissolved: r.dissolved };
      const newParent = item ? parse(item).parent_asin : null;
      const change = item
        ? parentChange(r.child, r.parent, newParent, today, extra)
        : ({
            detected_on: today,
            type: "left_family",
            asin: r.child,
            family_asin: r.parent,
            details: { old_parent: r.parent, child_missing: true, ...extra },
          } satisfies EventRow);
      if (!change) {
        log(`catalog: ${r.parent} no longer lists ${r.child}, but ${r.child} still points to it — not alerting`);
        continue;
      }
      events.push(change);
      // Record the new parent now so the child's own check doesn't report the same split again tomorrow.
      must(
        await db()
          .from("asins")
          .update({ parent_asin: newParent, ever_in_family: true, ...(item ? {} : { catalog_found: false }) })
          .eq("asin", r.child),
        "confirm removed child"
      );
    }
  }
  return events;
}

export async function catalogStep(
  today: string,
  deadline: number,
  log: (m: string) => void
): Promise<{ done: boolean; checked: number; events: number }> {
  let checked = 0;
  let eventCount = 0;

  while (Date.now() < deadline) {
    const queue = must(
      await db()
        .from("asins")
        .select("*")
        .eq("tracked", true)
        .or(`catalog_checked_on.is.null,catalog_checked_on.lt.${today}`)
        .order("asin")
        .limit(CATALOG_BATCH),
      "catalog queue"
    ) as AsinRow[];
    if (queue.length === 0) {
      log(`catalog: done (${checked} checked this run)`);
      return { done: true, checked, events: eventCount };
    }

    const items = await getCatalogItems(queue.map((r) => r.asin));
    const byAsin = new Map(items.map((i) => [i.asin.toUpperCase(), i]));
    const now = new Date().toISOString();
    const found: Record<string, unknown>[] = [];
    const missing: string[] = [];
    const snapshots: Record<string, unknown>[] = [];
    const discovered = new Map<string, Record<string, unknown>>();
    const events: EventRow[] = [];
    const removed: RemovedChild[] = [];

    for (const row of queue) {
      const item = byAsin.get(row.asin);
      if (!item) {
        missing.push(row.asin);
        continue;
      }
      let fam = parse(item);
      // Only compare once we have a baseline, and double-check before raising an alarm.
      if (row.catalog_checked_on && changed(row, fam)) {
        await sleep(CATALOG_PAUSE_MS);
        const [again] = await getCatalogItems([row.asin]);
        if (again) fam = parse(again);
        if (changed(row, fam)) {
          const d = diff(row, fam, today);
          events.push(...d.events);
          removed.push(...d.removed);
        }
      }

      found.push({
        asin: row.asin,
        title: fam.title ?? row.title,
        brand: fam.brand ?? row.brand,
        image_url: fam.image_url ?? row.image_url,
        variation_label: fam.variation_label,
        item_classification: fam.item_classification,
        is_parent: fam.is_parent,
        parent_asin: fam.parent_asin,
        child_asins: fam.child_asins,
        variation_theme: fam.variation_theme,
        ever_in_family: row.ever_in_family || Boolean(fam.parent_asin),
        catalog_found: true,
        catalog_checked_on: today,
        updated_at: now,
      });
      snapshots.push({
        captured_on: today,
        asin: row.asin,
        parent_asin: fam.parent_asin,
        child_asins: fam.child_asins,
      });
      // Pull the rest of the family into tracking: siblings share the review pool.
      if (fam.parent_asin && !discovered.has(fam.parent_asin)) {
        discovered.set(fam.parent_asin, { asin: fam.parent_asin, parent_asin: null, ever_in_family: false, is_parent: true });
      }
      for (const child of fam.child_asins) {
        if (!discovered.has(child)) {
          discovered.set(child, { asin: child, parent_asin: row.asin, ever_in_family: true, is_parent: false });
        }
      }
    }
    if (removed.length) events.push(...(await verifyRemoved(removed, today, log)));

    if (found.length) {
      must(await db().from("asins").upsert(found, { onConflict: "asin" }), "asins update");
      must(
        await db().from("family_snapshots").upsert(snapshots, { onConflict: "captured_on,asin" }),
        "family snapshot"
      );
    }
    if (missing.length) {
      must(
        await db()
          .from("asins")
          .update({ catalog_found: false, catalog_checked_on: today, updated_at: now })
          .in("asin", missing),
        "asins missing"
      );
    }
    if (discovered.size) {
      must(
        await db().from("asins").upsert([...discovered.values()], { onConflict: "asin", ignoreDuplicates: true }),
        "asins discover"
      );
    }
    if (events.length) {
      await recordEvents(events);
      eventCount += events.length;
      // Re-read reviews for the whole affected family today, even if already checked.
      const asins = [...new Set(events.map((e) => e.asin))];
      const families = [...new Set(events.map((e) => e.family_asin).filter(Boolean))] as string[];
      must(await db().from("asins").update({ keepa_priority: true }).in("asin", asins), "priority asins");
      must(
        await db().from("asins").update({ keepa_priority: true }).in("parent_asin", families),
        "priority families"
      );
      log(`catalog: ${events.length} family change(s) — ${events.map((e) => `${e.type} ${e.asin}`).join(", ")}`);
    }

    checked += queue.length;
    await sleep(CATALOG_PAUSE_MS);
  }
  return { done: false, checked, events: eventCount };
}
