import { db, must } from "./db";
import type { AsinRow } from "./types";

/**
 * Families with variations that aren't sharing the family's reviews right now,
 * however long ago it happened. While pooled, every variation shows the same
 * ratings count — but Keepa refreshes variations on different days, so an old
 * reading can lag the family by a few percent without anything being wrong.
 */
const FRESH_DAYS = 14;
const FRESH_GAP = 0.9; // read around the same time: anything 10%+ lower is split
const STALE_GAP = 0.5; // older reading: only under half the family can't be explained by growth since

export interface SplitFamily {
  parent: string;
  title: string | null;
  top: Variation;
  split: Variation[];
}

interface Variation {
  asin: string;
  label: string | null;
  ratings: number;
  image: string | null;
  asOf: string | null;
}

const days = (a: string | null, b: string | null) =>
  a && b ? Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000 : Infinity;

export function splitVariations(kids: AsinRow[]): { top: AsinRow; split: AsinRow[] } | null {
  if (kids.length < 2) return null;
  const top = kids.reduce((a, b) => (b.rating_count! > a.rating_count! ? b : a));
  const split = kids.filter((k) => {
    if (k === top || top.rating_count! - k.rating_count! < 10) return false;
    const gap = days(k.keepa_rating_at, top.keepa_rating_at) <= FRESH_DAYS ? FRESH_GAP : STALE_GAP;
    return k.rating_count! < top.rating_count! * gap;
  });
  return split.length ? { top, split } : null;
}

export async function familiesNotSharing(): Promise<SplitFamily[]> {
  const rows: AsinRow[] = [];
  for (let after = ""; ; ) {
    const page = must(
      await db()
        .from("asins")
        .select("*")
        .eq("is_parent", false)
        .not("parent_asin", "is", null)
        .not("rating_count", "is", null)
        .gt("asin", after)
        .order("asin")
        .limit(1000),
      "family variations"
    ) as AsinRow[];
    rows.push(...page);
    if (page.length < 1000) break;
    after = page.at(-1)!.asin;
  }

  const byParent = new Map<string, AsinRow[]>();
  for (const r of rows) byParent.set(r.parent_asin!, [...(byParent.get(r.parent_asin!) ?? []), r]);
  const found = [...byParent]
    .map(([parent, kids]) => ({ parent, result: splitVariations(kids) }))
    .filter((f): f is { parent: string; result: { top: AsinRow; split: AsinRow[] } } => f.result !== null);
  if (!found.length) return [];

  const titles = new Map(
    (must(await db().from("asins").select("asin, title").in("asin", found.map((f) => f.parent)), "parents") as {
      asin: string;
      title: string | null;
    }[]).map((p) => [p.asin, p.title])
  );
  const v = (k: AsinRow): Variation => ({
    asin: k.asin,
    label: k.variation_label,
    ratings: k.rating_count!,
    image: k.image_url,
    asOf: k.keepa_rating_at,
  });
  return found
    .map(({ parent, result }) => ({
      parent,
      title: titles.get(parent) ?? result.top.title,
      top: v(result.top),
      split: result.split.map(v).sort((a, b) => a.ratings - b.ratings),
    }))
    .sort((a, b) => b.top.ratings - a.top.ratings);
}
