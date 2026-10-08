import { db, must } from "./db";
import { createReport, downloadReport, getReport } from "./spapi";
import { sleep } from "./time";

const REPORT_TYPE = "GET_MERCHANT_LISTINGS_ALL_DATA";
const MAX_ATTEMPTS = 3;
const IGNORED_SKU = /^amzn\.gr\./i; // Amazon Grade & Resell relists, not real listings

interface RunRow {
  run_on: string;
  listings_report_id: string | null;
  listings_attempts: number;
}

/**
 * Pull every listing we have (active and inactive) so the tracker knows which
 * ASINs are ours. One report per day; it usually takes Amazon 1–3 minutes.
 */
export async function listingsStep(
  run: RunRow,
  deadline: number,
  log: (m: string) => void
): Promise<{ done: boolean; listed?: number; error?: string }> {
  const runs = () => db().from("daily_runs");
  let reportId = run.listings_report_id;
  let attempts = run.listings_attempts;
  if (!reportId) {
    reportId = await createReport(REPORT_TYPE);
    attempts += 1;
    must(
      await runs().update({ listings_report_id: reportId, listings_attempts: attempts }).eq("run_on", run.run_on),
      "save report id"
    );
    log(`listings: requested report ${reportId} (attempt ${attempts})`);
  }

  while (Date.now() < deadline - 20_000) {
    const rep = await getReport(reportId);
    if (rep.processingStatus === "DONE" && rep.reportDocumentId) {
      const listed = await ingest(await downloadReport(rep.reportDocumentId));
      log(`listings: ${listed} ASINs listed`);
      return { done: true, listed };
    }
    if (rep.processingStatus === "CANCELLED" || rep.processingStatus === "FATAL") {
      const error = `listings report ${rep.processingStatus}`;
      if (attempts >= MAX_ATTEMPTS) return { done: true, error };
      must(await runs().update({ listings_report_id: null }).eq("run_on", run.run_on), "clear report id");
      log(`${error}, will retry`);
      return { done: false };
    }
    await sleep(15_000);
  }
  return { done: false };
}

async function ingest(tsv: string): Promise<number> {
  const lines = tsv.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0]?.split("\t").map((h) => h.trim().toLowerCase()) ?? [];
  const col = (name: string) => header.indexOf(name);
  const iSku = col("seller-sku");
  const iAsin = col("asin1");
  const iStatus = col("status");
  if (iSku < 0 || iAsin < 0) throw new Error(`listings report missing columns; header: ${header.join(",")}`);

  const byAsin = new Map<string, { skus: string[]; active: boolean; statuses: Set<string> }>();
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const sku = cells[iSku]?.trim();
    const asin = cells[iAsin]?.trim().toUpperCase();
    if (!sku || !asin || IGNORED_SKU.test(sku)) continue;
    const status = cells[iStatus]?.trim() || "Unknown";
    const entry = byAsin.get(asin) ?? { skus: [], active: false, statuses: new Set<string>() };
    entry.skus.push(sku);
    entry.statuses.add(status);
    if (status.toLowerCase() === "active") entry.active = true;
    byAsin.set(asin, entry);
  }

  const rows = [...byAsin].map(([asin, e]) => ({
    asin,
    skus: e.skus.sort(),
    listed: true,
    listing_status: e.active ? "Active" : [...e.statuses].join(", "),
    updated_at: new Date().toISOString(),
  }));
  for (let i = 0; i < rows.length; i += 500) {
    must(await db().from("asins").upsert(rows.slice(i, i + 500), { onConflict: "asin" }), "asins upsert");
  }

  // Anything we used to list but no longer do stays tracked only if it's in a family.
  const previouslyListed: string[] = [];
  for (let after = ""; ; ) {
    const page = must(
      await db().from("asins").select("asin").eq("listed", true).gt("asin", after).order("asin").limit(1000),
      "listed asins"
    );
    previouslyListed.push(...page.map((r) => r.asin as string));
    if (page.length < 1000) break;
    after = page.at(-1)!.asin as string;
  }
  const gone = previouslyListed.filter((a) => !byAsin.has(a));
  for (let i = 0; i < gone.length; i += 200) {
    must(
      await db().from("asins").update({ listed: false }).in("asin", gone.slice(i, i + 200)),
      "unlist asins"
    );
  }
  return rows.length;
}
