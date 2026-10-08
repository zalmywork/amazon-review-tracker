import { db, must } from "./db";
import { recordEvents } from "./events";
import {
  KEEPA_MAX_BATCH,
  KEEPA_TOKENS_PER_ASIN,
  KeepaOutOfTokens,
  dropStartedAt,
  keepaProducts,
  keepaTokensLeft,
  readReviews,
} from "./keepa";
import type { AsinRow, EventRow } from "./types";

/**
 * Daily ratings check via Keepa for every variation in a family we sell in.
 * A sharp fall in the ratings a listing shows is the review-side signal of a
 * split — it also catches Amazon un-pooling reviews while the family itself
 * stays intact, which the catalog check alone can't see.
 */

const LOOKBACK_DAYS = 60;
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
export const dropThresholds = () => ({
  minRatings: num(process.env.ALERT_MIN_DROP, 10),
  minPct: num(process.env.ALERT_MIN_DROP_PCT, 10),
});
const isDrop = (before: number, after: number) => {
  const { minRatings, minPct } = dropThresholds();
  const drop = before - after;
  return drop >= minRatings && drop >= (before * minPct) / 100;
};

/** ASINs still to read today: family variations, priority first, then the stalest. */
export function keepaQueue(today: string, limit: number) {
  return db()
    .from("asins")
    .select("*")
    .eq("tracked", true)
    .eq("ever_in_family", true)
    .eq("is_parent", false)
    .or(`keepa_priority.eq.true,keepa_checked_on.is.null,keepa_checked_on.lt.${today}`)
    .order("keepa_priority", { ascending: false })
    .order("keepa_checked_on", { ascending: true, nullsFirst: true })
    .order("asin")
    .limit(limit);
}

export async function keepaPending(today: string): Promise<number> {
  const { count, error } = await db()
    .from("asins")
    .select("asin", { count: "exact", head: true })
    .eq("tracked", true)
    .eq("ever_in_family", true)
    .eq("is_parent", false)
    .or(`keepa_priority.eq.true,keepa_checked_on.is.null,keepa_checked_on.lt.${today}`);
  if (error) throw new Error(`keepa pending: ${error.message}`);
  return count ?? 0;
}

/** The family a variation most recently belonged to, so a split-off ASIN's drop groups with its old family. */
async function lastFamily(asin: string): Promise<string | null> {
  const rows = must(
    await db()
      .from("events")
      .select("family_asin")
      .eq("asin", asin)
      .in("type", ["left_family", "moved_family"])
      .order("id", { ascending: false })
      .limit(1),
    "last family"
  );
  return (rows[0]?.family_asin as string | undefined) ?? null;
}

export async function reviewsStep(
  today: string,
  deadline: number,
  log: (m: string) => void
): Promise<{ done: boolean; checked: number; events: number; tokensLeft?: number; waiting?: string }> {
  const reserve = num(process.env.KEEPA_RESERVE_TOKENS, 100);
  let tokens = await keepaTokensLeft();
  let checked = 0;
  let eventCount = 0;

  while (Date.now() < deadline) {
    const batchSize = Math.min(KEEPA_MAX_BATCH, Math.floor((tokens - reserve) / KEEPA_TOKENS_PER_ASIN));
    if (batchSize < 1) {
      log(`keepa: waiting for tokens (${tokens} left, keeping ${reserve} in reserve)`);
      return { done: false, checked, events: eventCount, tokensLeft: tokens, waiting: "keepa tokens" };
    }
    const queue = must(await keepaQueue(today, batchSize), "keepa queue") as AsinRow[];
    if (queue.length === 0) {
      log(`keepa: done (${checked} read this run, ${tokens} tokens left)`);
      return { done: true, checked, events: eventCount, tokensLeft: tokens };
    }

    let products;
    try {
      ({ products, tokensLeft: tokens } = await keepaProducts(
        queue.map((r) => r.asin),
        LOOKBACK_DAYS
      ));
    } catch (e) {
      if (e instanceof KeepaOutOfTokens) {
        return { done: false, checked, events: eventCount, tokensLeft: 0, waiting: "keepa tokens" };
      }
      throw e;
    }
    const byAsin = new Map(products.map((p) => [p.asin.toUpperCase(), p]));
    const events: EventRow[] = [];
    const updates: Record<string, unknown>[] = [];
    const snapshots: Record<string, unknown>[] = [];

    for (const row of queue) {
      const p = byAsin.get(row.asin);
      const r = p ? readReviews(p) : null;
      const count = r?.ratingCount ?? null;

      if (r && count !== null) {
        const family = row.parent_asin ?? null;
        if (row.keepa_checked_on && row.rating_count !== null && isDrop(row.rating_count, count)) {
          events.push({
            detected_on: today,
            type: "ratings_drop",
            asin: row.asin,
            family_asin: family ?? (await lastFamily(row.asin)),
            details: {
              before: row.rating_count,
              after: count,
              rating_before: row.rating,
              rating_after: r.rating,
              own_reviews: r.ownReviewCount,
              changed_at: dropStartedAt(r.ratingHistory, count),
              keepa_as_of: r.ratingAt,
            },
          });
        }
        if (!row.keepa_checked_on) events.push(...history(row, r, today));
      }

      updates.push({
        asin: row.asin,
        rating_count: count ?? row.rating_count,
        rating: r?.rating ?? row.rating,
        own_review_count: r?.ownReviewCount ?? row.own_review_count,
        keepa_parent_asin: r?.parentAsin ?? null,
        keepa_rating_at: r?.ratingAt ?? row.keepa_rating_at,
        image_url: row.image_url ?? r?.imageUrl ?? null,
        keepa_checked_on: today,
        keepa_priority: false,
        updated_at: new Date().toISOString(),
      });
      if (r) {
        snapshots.push({
          captured_on: today,
          asin: row.asin,
          rating_count: count,
          rating: r.rating,
          own_review_count: r.ownReviewCount,
          keepa_parent_asin: r.parentAsin,
          keepa_rating_at: r.ratingAt,
        });
      }
    }

    must(await db().from("asins").upsert(updates, { onConflict: "asin" }), "asins reviews");
    if (snapshots.length) {
      must(
        await db().from("review_snapshots").upsert(snapshots, { onConflict: "captured_on,asin" }),
        "review snapshot"
      );
    }
    if (events.length) {
      await recordEvents(events);
      eventCount += events.length;
      log(`keepa: ${events.length} ratings event(s)`);
    }
    checked += queue.length;
  }
  return { done: false, checked, events: eventCount, tokensLeft: tokens };
}

/**
 * First time we see a variation, look back through Keepa's history so the
 * first email can show splits that happened shortly before tracking began.
 */
function history(row: AsinRow, r: ReturnType<typeof readReviews>, today: string): EventRow[] {
  const out: EventRow[] = [];
  const since = Date.now() - LOOKBACK_DAYS * 86_400_000;
  for (const change of r.parentChanges) {
    if (new Date(change.endedAt).getTime() < since) continue;
    out.push({
      detected_on: today,
      type: "history_parent_change",
      asin: row.asin,
      family_asin: change.previousParent,
      details: {
        old_parent: change.previousParent,
        new_parent: r.parentAsin,
        changed_at: change.endedAt,
      },
    });
  }
  const now = r.ratingCount;
  if (now !== null && r.ratingHistory.length) {
    const peak = Math.max(...r.ratingHistory.map((h) => h.value));
    if (isDrop(peak, now)) {
      out.push({
        detected_on: today,
        type: "history_ratings_drop",
        asin: row.asin,
        family_asin: row.parent_asin ?? r.parentChanges.at(-1)?.previousParent ?? null,
        details: {
          before: peak,
          after: now,
          rating_after: r.rating,
          own_reviews: r.ownReviewCount,
          changed_at: dropStartedAt(r.ratingHistory, now),
          keepa_as_of: r.ratingAt,
        },
      });
    }
  }
  return out;
}
