import { gunzipSync } from "node:zlib";
import { sleep } from "./time";

/**
 * Minimal Amazon SP-API client (LWA refresh-token auth, no SigV4 needed).
 * Same credentials as the profit tracker / kook-amazon-reports.
 */

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

const endpoint = () => process.env.SPAPI_ENDPOINT || "https://sellingpartnerapi-na.amazon.com";
export const marketplaceId = () => process.env.SPAPI_MARKETPLACE_ID || "ATVPDKIKX0DER";

let tokenCache: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.token;
  const { LWA_CLIENT_ID, LWA_CLIENT_SECRET, LWA_REFRESH_TOKEN } = process.env;
  if (!LWA_CLIENT_ID || !LWA_CLIENT_SECRET || !LWA_REFRESH_TOKEN) {
    throw new Error("Missing LWA_CLIENT_ID / LWA_CLIENT_SECRET / LWA_REFRESH_TOKEN env vars");
  }
  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: LWA_REFRESH_TOKEN,
      client_id: LWA_CLIENT_ID,
      client_secret: LWA_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`LWA token exchange failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

async function sp<T>(
  method: "GET" | "POST",
  path: string,
  opts: { params?: Record<string, string>; body?: unknown } = {}
): Promise<T> {
  const qs = opts.params ? `?${new URLSearchParams(opts.params)}` : "";
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${endpoint()}${path}${qs}`, {
      method,
      headers: {
        "x-amz-access-token": await accessToken(),
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.ok) return (await res.json()) as T;
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep(Math.min(20_000, 2_000 * 2 ** attempt));
      continue;
    }
    const hint =
      res.status === 403
        ? " — the SP-API app may be missing a role (Product Listing / Inventory and Order Tracking); add it in Seller Central → Develop Apps and re-authorize"
        : "";
    throw new Error(`SP-API ${method} ${path} failed (${res.status})${hint}: ${await res.text()}`);
  }
}

// ---------- Catalog Items API (2022-04-01) ----------

export interface CatalogItem {
  asin: string;
  images?: {
    marketplaceId: string;
    images: { link: string; height: number; width: number; variant: string }[];
  }[];
  summaries?: {
    marketplaceId: string;
    itemName?: string;
    brand?: string;
    color?: string;
    size?: string;
    style?: string;
    itemClassification?: string;
  }[];
  relationships?: {
    marketplaceId: string;
    relationships: {
      type: string;
      parentAsins?: string[];
      childAsins?: string[];
      variationTheme?: { attributes?: string[]; theme?: string };
    }[];
  }[];
}

/** Amazon accepts at most 20 identifiers per call, and searchCatalogItems allows 2 calls/second. */
export const CATALOG_BATCH = 20;
export const CATALOG_PAUSE_MS = 600;

export async function getCatalogItems(asins: string[]): Promise<CatalogItem[]> {
  if (asins.length === 0) return [];
  const data = await sp<{ items?: CatalogItem[] }>("GET", "/catalog/2022-04-01/items", {
    params: {
      identifiers: asins.join(","),
      identifiersType: "ASIN",
      marketplaceIds: marketplaceId(),
      includedData: "images,summaries,relationships",
      locale: "en_US",
      // Default page size is 10, which silently drops half of a 20-ASIN batch.
      pageSize: String(CATALOG_BATCH),
    },
  });
  return data.items ?? [];
}

// ---------- Reports API (2021-06-30) ----------

export async function createReport(reportType: string): Promise<string> {
  const r = await sp<{ reportId: string }>("POST", "/reports/2021-06-30/reports", {
    body: { reportType, marketplaceIds: [marketplaceId()] },
  });
  return r.reportId;
}

export async function getReport(reportId: string) {
  return sp<{
    processingStatus: "IN_QUEUE" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "FATAL";
    reportDocumentId?: string;
  }>("GET", `/reports/2021-06-30/reports/${reportId}`);
}

export async function downloadReport(documentId: string): Promise<string> {
  const doc = await sp<{ url: string; compressionAlgorithm?: string }>(
    "GET",
    `/reports/2021-06-30/documents/${documentId}`
  );
  const res = await fetch(doc.url);
  if (!res.ok) throw new Error(`report download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const raw = doc.compressionAlgorithm === "GZIP" ? gunzipSync(buf) : buf;
  return new TextDecoder("utf-8").decode(raw);
}
