import { cronAuthorized } from "@/lib/auth";
import { parse } from "@/lib/catalog";
import { db, must } from "@/lib/db";
import { keepaProducts, keepaTime, readReviews } from "@/lib/keepa";
import { getCatalogItems } from "@/lib/spapi";

/**
 * Everything known about one ASIN: our stored row, snapshots and events, plus
 * what Amazon's catalog and Keepa say right now. Costs ~2 Keepa tokens.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  const asin = new URL(req.url).searchParams.get("asin")?.trim().toUpperCase();
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return Response.json({ error: "pass ?asin=B0XXXXXXXX" }, { status: 400 });

  const [row, families, reviews, events, catalog, keepa] = await Promise.all([
    db().from("asins").select("*").eq("asin", asin).maybeSingle(),
    db().from("family_snapshots").select("*").eq("asin", asin).order("captured_on", { ascending: false }).limit(10),
    db().from("review_snapshots").select("*").eq("asin", asin).order("captured_on", { ascending: false }).limit(10),
    db().from("events").select("*").eq("asin", asin).order("id", { ascending: false }).limit(20),
    getCatalogItems([asin]),
    keepaProducts([asin], 365),
  ]);

  const p = keepa.products[0];
  const r = p ? readReviews(p) : null;
  return Response.json({
    stored: must(row, "row"),
    familySnapshots: must(families, "family snapshots"),
    reviewSnapshots: must(reviews, "review snapshots"),
    events: must(events, "events"),
    amazonNow: catalog[0] ? parse(catalog[0]) : "not found in catalog",
    keepaNow: r && {
      ratingCount: r.ratingCount,
      rating: r.rating,
      ownReviews: r.ownReviewCount,
      ratingDataAsOf: r.ratingAt,
      parentAsin: r.parentAsin,
      rawParentAsinHistory: (p.parentAsinHistory ?? []).map((v, i) => (i % 2 === 0 ? keepaTime(Number(v)) : v)),
      ratingCountHistory: r.ratingHistory.map((h) => `${keepaTime(h.at).slice(0, 10)}: ${h.value}`),
    },
    keepaTokensLeft: keepa.tokensLeft,
  });
}
