/**
 * Keepa API — the only source of the ratings count a listing shows. Amazon's
 * own APIs don't expose review counts at all.
 *
 * Cost: 1 token per ASIN, plus 1 more for `rating=1` when Keepa's rating data
 * is under 14 days old. Up to 100 ASINs per request.
 */

const KEEPA = "https://api.keepa.com";
const KEEPA_EPOCH_MINUTES = 21_564_000;
export const KEEPA_MAX_BATCH = 100;
export const KEEPA_TOKENS_PER_ASIN = 2;
const CSV_RATING = 16;
const CSV_COUNT_REVIEWS = 17;

export const keepaTime = (minutes: number) =>
  new Date((minutes + KEEPA_EPOCH_MINUTES) * 60_000).toISOString();

export class KeepaOutOfTokens extends Error {}

export interface KeepaProduct {
  asin: string;
  parentAsin?: string | null;
  parentAsinHistory?: (string | number)[] | null;
  csv?: (number[] | null)[] | null;
  lastRatingUpdate?: number;
  reviews?: { lastUpdate?: number; reviewCount?: number[] | null } | null;
}

function key(): string {
  const k = process.env.KEEPA_API_KEY;
  if (!k) throw new Error("Missing KEEPA_API_KEY env var");
  return k;
}

async function keepaGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`${KEEPA}${path}?${new URLSearchParams({ key: key(), ...params })}`);
  if (res.status === 429) throw new KeepaOutOfTokens("Keepa is out of tokens");
  if (!res.ok) throw new Error(`Keepa ${path} failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as T;
}

/** Free call — how many tokens are available right now. */
export async function keepaTokensLeft(): Promise<number> {
  const r = await keepaGet<{ tokensLeft: number }>("/token", {});
  return r.tokensLeft;
}

export async function keepaProducts(
  asins: string[],
  lookbackDays: number
): Promise<{ products: KeepaProduct[]; tokensLeft: number }> {
  const r = await keepaGet<{ products?: KeepaProduct[]; tokensLeft: number }>("/product", {
    domain: "1",
    asin: asins.join(","),
    rating: "1",
    days: String(lookbackDays),
  });
  return { products: r.products ?? [], tokensLeft: r.tokensLeft };
}

/** Pairs of [timestamp, value] from a Keepa history array, skipping "no data" (-1). */
export function series(raw: number[] | null | undefined): { at: number; value: number }[] {
  const out: { at: number; value: number }[] = [];
  if (!raw) return out;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i + 1] >= 0) out.push({ at: raw[i], value: raw[i + 1] });
  }
  return out;
}

export interface ReviewReading {
  /** Ratings shown on the listing — pooled across the whole family while it's intact. */
  ratingCount: number | null;
  rating: number | null;
  /** Written reviews on this one variation only. */
  ownReviewCount: number | null;
  ratingAt: string | null;
  ratingHistory: { at: number; value: number }[];
  parentAsin: string | null;
  /** Earlier parents and when each stopped being the parent. */
  parentChanges: { previousParent: string; endedAt: string }[];
}

export function readReviews(p: KeepaProduct): ReviewReading {
  const counts = series(p.csv?.[CSV_COUNT_REVIEWS]);
  const ratings = series(p.csv?.[CSV_RATING]);
  const own = series(p.reviews?.reviewCount);
  const parentChanges: ReviewReading["parentChanges"] = [];
  const h = p.parentAsinHistory ?? [];
  for (let i = 0; i + 1 < h.length; i += 2) {
    const minutes = Number(h[i]);
    if (Number.isFinite(minutes) && h[i + 1]) {
      parentChanges.push({ previousParent: String(h[i + 1]), endedAt: keepaTime(minutes) });
    }
  }
  return {
    ratingCount: counts.at(-1)?.value ?? null,
    rating: ratings.length ? ratings.at(-1)!.value / 10 : null,
    ownReviewCount: own.at(-1)?.value ?? null,
    ratingAt: p.lastRatingUpdate ? keepaTime(p.lastRatingUpdate) : null,
    ratingHistory: counts,
    parentAsin: p.parentAsin ?? null,
    parentChanges,
  };
}

/** When the ratings count first fell to (about) its current level, per Keepa's history. */
export function dropStartedAt(history: { at: number; value: number }[], now: number): string | null {
  const ceiling = now * 1.02 + 2;
  let start: number | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].value > ceiling) break;
    start = history[i].at;
  }
  return start === null ? null : keepaTime(start);
}
