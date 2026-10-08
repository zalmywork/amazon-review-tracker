import { db, must } from "./db";
import type { WelcomeInfo } from "./digest";
import type { AsinRow, EventRow } from "./types";

/** On the first day, changes can only come from Keepa's history. */
export const asHistory = (events: EventRow[]): EventRow[] =>
  events.map((e) => ({
    ...e,
    type: e.type === "ratings_drop" ? "history_ratings_drop" : e.type === "left_family" ? "history_parent_change" : e.type,
  }));

export const SAMPLE_WELCOME: WelcomeInfo = { families: 80, variations: 378, listed: 576 };

/** Made-up data so the email can be previewed before any real change happens. */
export function sampleDigestData(date: string): { events: EventRow[]; asins: Map<string, AsinRow> } {
  const base: Omit<AsinRow, "asin"> = {
    skus: [],
    listed: true,
    listing_status: "Active",
    title: null,
    brand: "Sample",
    image_url: null,
    variation_label: null,
    item_classification: "VARIATION_CHILD",
    is_parent: false,
    parent_asin: null,
    child_asins: [],
    variation_theme: null,
    ever_in_family: true,
    catalog_found: true,
    catalog_checked_on: date,
    rating_count: null,
    rating: null,
    own_review_count: null,
    keepa_parent_asin: null,
    keepa_rating_at: null,
    keepa_checked_on: date,
    keepa_priority: false,
  };
  const day = (offset: number, hour = 15) => new Date(Date.parse(`${date}T${String(hour).padStart(2, "0")}:10:00-04:00`) - offset * 86_400_000).toISOString();
  const rows: AsinRow[] = [
    { ...base, asin: "B0SAMPLEP1", title: "LED Bike Light Set, USB Rechargeable Front and Rear", is_parent: true, listed: false, ever_in_family: false, item_classification: "VARIATION_PARENT", variation_theme: "COLOR_NAME", child_asins: ["B0SAMPLE01", "B0SAMPLE03", "B0SAMPLE04"] },
    { ...base, asin: "B0SAMPLE01", title: "LED Bike Light Set - Black", variation_label: "Black", skus: ["LIGHT-BLK"], parent_asin: "B0SAMPLEP1", rating_count: 4868, rating: 4.4, own_review_count: 1203, keepa_rating_at: day(1) },
    { ...base, asin: "B0SAMPLE02", title: "LED Bike Light Set - Red", variation_label: "Red", skus: ["LIGHT-RED"], parent_asin: null, rating_count: 342, rating: 4.1, own_review_count: 88, keepa_rating_at: day(1) },
    { ...base, asin: "B0SAMPLE03", title: "LED Bike Light Set - Blue", variation_label: "Blue", skus: ["LIGHT-BLU"], parent_asin: "B0SAMPLEP1", rating_count: 4868, rating: 4.4, own_review_count: 640, keepa_rating_at: day(1) },
    { ...base, asin: "B0SAMPLE04", title: "LED Bike Light Set - Green", variation_label: "Green", skus: ["LIGHT-GRN"], parent_asin: "B0SAMPLEP1", rating_count: 4868, rating: 4.4, own_review_count: 212, keepa_rating_at: day(1) },
    { ...base, asin: "B0SAMPLEP2", title: "Insulated Water Bottle, 24 oz, Leak-Proof Lid", is_parent: true, listed: false, ever_in_family: false, item_classification: "VARIATION_PARENT", variation_theme: "SIZE_NAME/COLOR_NAME", child_asins: ["B0SAMPLE11", "B0SAMPLE12", "B0SAMPLE13"] },
    { ...base, asin: "B0SAMPLE11", title: "Insulated Water Bottle 24 oz - Matte Black", variation_label: "Matte Black / 24 oz", skus: ["BTL-24-BLK"], parent_asin: "B0SAMPLEP2", rating_count: 1102, rating: 4.6, own_review_count: 301, keepa_rating_at: day(2) },
    { ...base, asin: "B0SAMPLE12", title: "Insulated Water Bottle 24 oz - Sage", variation_label: "Sage / 24 oz", skus: ["BTL-24-SAG"], parent_asin: "B0SAMPLEP2", rating_count: 611, rating: 4.5, own_review_count: 150, keepa_rating_at: day(2) },
    { ...base, asin: "B0SAMPLE13", title: "Insulated Water Bottle 32 oz - Sage", variation_label: "Sage / 32 oz", skus: ["BTL-32-SAG"], parent_asin: "B0SAMPLEP2", rating_count: 267, rating: 4.7, own_review_count: 71, keepa_rating_at: day(2) },
  ];
  const asins = new Map(rows.map((r) => [r.asin, r]));
  const drop = (asin: string, family: string, before: number, after: number, rb: number, ra: number, own: number, at: string): EventRow => ({
    detected_on: date,
    type: "ratings_drop",
    asin,
    family_asin: family,
    details: { before, after, rating_before: rb, rating_after: ra, own_reviews: own, changed_at: at, keepa_as_of: at },
  });
  const events: EventRow[] = [
    { detected_on: date, type: "left_family", asin: "B0SAMPLE02", family_asin: "B0SAMPLEP1", details: { old_parent: "B0SAMPLEP1", source: "child" } },
    drop("B0SAMPLE02", "B0SAMPLEP1", 5210, 342, 4.4, 4.1, 88, day(1)),
    drop("B0SAMPLE01", "B0SAMPLEP1", 5210, 4868, 4.4, 4.4, 1203, day(1)),
    drop("B0SAMPLE03", "B0SAMPLEP1", 5210, 4868, 4.4, 4.4, 640, day(1)),
    drop("B0SAMPLE04", "B0SAMPLEP1", 5210, 4868, 4.4, 4.4, 212, day(1)),
    drop("B0SAMPLE11", "B0SAMPLEP2", 1980, 1102, 4.6, 4.6, 301, day(2, 9)),
    drop("B0SAMPLE12", "B0SAMPLEP2", 1980, 611, 4.6, 4.5, 150, day(2, 9)),
    drop("B0SAMPLE13", "B0SAMPLEP2", 1980, 267, 4.6, 4.7, 71, day(2, 9)),
  ];
  return { events, asins };
}

/**
 * The sample built from two of our own families (real names and images, made-up
 * changes), so a test email looks like the real thing. Falls back to the
 * made-up sample until the catalog has been read.
 */
export async function sampleFromCatalog(date: string): Promise<{ events: EventRow[]; asins: Map<string, AsinRow> }> {
  const kids = must(
    await db()
      .from("asins")
      .select("*")
      .not("parent_asin", "is", null)
      .not("rating_count", "is", null)
      .not("image_url", "is", null)
      .order("rating_count", { ascending: false })
      .limit(300),
    "sample families"
  ) as AsinRow[];
  const byParent = new Map<string, AsinRow[]>();
  for (const k of kids) byParent.set(k.parent_asin!, [...(byParent.get(k.parent_asin!) ?? []), k]);
  const families = [...byParent].filter(([, members]) => members.length >= 3).slice(0, 2);
  if (families.length < 2) return sampleDigestData(date);

  const parents = must(await db().from("asins").select("*").in("asin", families.map(([p]) => p)), "sample parents") as AsinRow[];
  const asins = new Map<string, AsinRow>([...parents, ...families.flatMap(([, m]) => m)].map((r) => [r.asin, r]));
  const yesterday = new Date(Date.parse(`${date}T15:00:00-04:00`) - 86_400_000).toISOString();
  const drop = (asin: string, family: string, before: number, after: number): EventRow => ({
    detected_on: date,
    type: "ratings_drop",
    asin,
    family_asin: family,
    details: { before, after, changed_at: yesterday },
  });

  const [[splitParent, a], [pooledParent, b]] = families;
  const total = a[0].rating_count!;
  const own = Math.max(1, Math.round(total * 0.12));
  const events: EventRow[] = [
    { detected_on: date, type: "left_family", asin: a[1].asin, family_asin: splitParent, details: { old_parent: splitParent } },
    drop(a[1].asin, splitParent, total, own),
    ...a.filter((m) => m.asin !== a[1].asin).map((m) => drop(m.asin, splitParent, total, total - own)),
    ...b.slice(0, 4).map((m, i) => drop(m.asin, pooledParent, m.rating_count!, Math.round(m.rating_count! * [0.55, 0.3, 0.12, 0.05][i]))),
  ];
  return { events, asins };
}
