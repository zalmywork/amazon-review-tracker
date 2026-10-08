import { db, must } from "./db";
import type { AsinRow } from "./types";

/**
 * Families whose variations don't show one shared ratings count right now —
 * i.e. reviews are split, however long ago it happened. While a family's
 * reviews are pooled every variation shows the same number.
 */
export interface SplitFamily {
  parent: string;
  title: string | null;
  variations: { asin: string; label: string | null; ratings: number; image: string | null; asOf: string | null }[];
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
  const split = [...byParent].filter(([, kids]) => {
    if (kids.length < 2) return false;
    const counts = kids.map((k) => k.rating_count!);
    const hi = Math.max(...counts);
    return hi - Math.min(...counts) > Math.max(2, hi * 0.02);
  });
  if (!split.length) return [];

  const parents = new Map(
    (must(await db().from("asins").select("asin, title").in("asin", split.map(([p]) => p)), "parents") as {
      asin: string;
      title: string | null;
    }[]).map((p) => [p.asin, p.title])
  );
  return split
    .map(([parent, kids]) => ({
      parent,
      title: parents.get(parent) ?? kids[0].title,
      variations: kids
        .map((k) => ({ asin: k.asin, label: k.variation_label, ratings: k.rating_count!, image: k.image_url, asOf: k.keepa_rating_at }))
        .sort((a, b) => b.ratings - a.ratings),
    }))
    .sort((a, b) => b.variations[0].ratings - a.variations[0].ratings);
}
