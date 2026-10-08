import { catalogStep } from "./catalog";
import { db, must } from "./db";
import { buildDigest, type WelcomeInfo } from "./digest";
import { listingsStep } from "./listings";
import { recipients, sendEmail } from "./mail";
import { keepaPending, reviewsStep } from "./reviews";
import { etDate, etHour } from "./time";
import type { AsinRow, EventRow } from "./types";

/**
 * One hourly tick of the daily job. Each day (New York time) it:
 *   1. pulls our listings from Amazon,
 *   2. checks every family in Amazon's catalog,
 *   3. reads ratings for every variation from Keepa (as tokens allow),
 *   4. after SEND_HOUR, emails Sara whatever changed.
 * Every step is resumable, so a tick that runs out of time just continues next hour.
 */

export interface DailyRun {
  run_on: string;
  listings_report_id: string | null;
  listings_attempts: number;
  listings_done_at: string | null;
  catalog_done_at: string | null;
  keepa_done_at: string | null;
  email_sent_at: string | null;
  email_result: string | null;
  stats: Record<string, unknown>;
  last_error: string | null;
  last_error_at: string | null;
  admin_alerted_at: string | null;
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
const keepaEnabled = () => Boolean(process.env.KEEPA_API_KEY);

async function getRun(day: string): Promise<DailyRun> {
  must(await db().from("daily_runs").upsert({ run_on: day }, { onConflict: "run_on", ignoreDuplicates: true }), "create run");
  return must(await db().from("daily_runs").select("*").eq("run_on", day).single(), "load run") as DailyRun;
}

async function saveRun(day: string, patch: Partial<DailyRun>) {
  must(
    await db().from("daily_runs").update({ ...patch, updated_at: new Date().toISOString() }).eq("run_on", day),
    "save run"
  );
}

export async function tick(opts: { budgetMs?: number } = {}) {
  const deadline = Date.now() + (opts.budgetMs ?? 240_000);
  const today = etDate();
  const logs: string[] = [];
  const log = (m: string) => {
    logs.push(m);
    console.log(`[review-tracker] ${m}`);
  };
  const run = await getRun(today);
  const stats: Record<string, unknown> = { ...run.stats };
  const result = (stage: string) => ({ today, stage, logs, stats });

  try {
    if (!run.listings_done_at) {
      const r = await listingsStep(run, deadline, log);
      if (!r.done) return result("listings");
      if (r.error) {
        const { count } = await db().from("asins").select("asin", { count: "exact", head: true }).eq("listed", true);
        if (!count) throw new Error(`${r.error} — and no listings are known yet`);
        log(`${r.error}; using yesterday's listings`);
      }
      Object.assign(stats, { listed: r.listed ?? stats.listed, listings_error: r.error ?? null });
      await saveRun(today, { listings_done_at: new Date().toISOString(), stats });
    }

    if (!run.catalog_done_at) {
      const r = await catalogStep(today, deadline, log);
      stats.catalog_checked = Number(stats.catalog_checked ?? 0) + r.checked;
      stats.family_changes = Number(stats.family_changes ?? 0) + r.events;
      if (!r.done) {
        await saveRun(today, { stats });
        return result("catalog");
      }
      await saveRun(today, { catalog_done_at: new Date().toISOString(), stats });
    }

    if (keepaEnabled() && Date.now() < deadline) {
      const r = await reviewsStep(today, deadline, log);
      stats.keepa_checked = Number(stats.keepa_checked ?? 0) + r.checked;
      stats.ratings_changes = Number(stats.ratings_changes ?? 0) + r.events;
      stats.keepa_tokens_left = r.tokensLeft ?? stats.keepa_tokens_left;
      await saveRun(today, { stats, ...(r.done && !run.keepa_done_at ? { keepa_done_at: new Date().toISOString() } : {}) });
    } else if (!keepaEnabled()) {
      log("keepa: KEEPA_API_KEY not set — family checks only, no ratings counts");
    }

    if (!run.email_sent_at) log(`email: ${await emailStep(today, log)}`);
    return result("done");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`ERROR: ${message}`);
    await saveRun(today, { last_error: message.slice(0, 4000), last_error_at: new Date().toISOString(), stats });
    await alertAdmin(run, today, message);
    throw err;
  }
}

async function alertAdmin(run: DailyRun, today: string, message: string) {
  const to = recipients(process.env.ADMIN_EMAIL);
  if (!to.length || run.admin_alerted_at) return;
  try {
    const safe = message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    await sendEmail({
      to,
      subject: `Review tracker error (${today})`,
      text: `The daily review check hit an error and will retry next hour.\n\n${message}`,
      html: `<p>The daily review check hit an error and will retry next hour.</p><pre style="white-space:pre-wrap">${safe}</pre>`,
    });
    await saveRun(today, { admin_alerted_at: new Date().toISOString() });
  } catch (e) {
    console.error("[review-tracker] could not alert admin", e);
  }
}

async function emailedBefore(today: string): Promise<boolean> {
  const rows = must(
    await db().from("daily_runs").select("email_result").lt("run_on", today).not("email_sent_at", "is", null),
    "past emails"
  );
  return rows.some((r) => r.email_result === "welcome" || String(r.email_result ?? "").startsWith("sent"));
}

async function emailStep(today: string, log: (m: string) => void): Promise<string> {
  const hour = etHour();
  const sendHour = num(process.env.SEND_HOUR, 8);
  if (hour < sendHour) return `waiting until ${sendHour}:00 ET`;

  const first = !(await emailedBefore(today));
  const pending = keepaEnabled() ? await keepaPending(today) : 0;
  // Give Keepa until 3 hours past send time; the very first email waits for the full baseline.
  if (pending > 0 && (first || hour < sendHour + 3)) return `waiting for Keepa (${pending} variations left)`;

  const to = recipients(process.env.ALERT_TO);
  if (!to.length) {
    await saveRun(today, { email_sent_at: new Date().toISOString(), email_result: "skipped: ALERT_TO not set" });
    return "skipped — ALERT_TO not set";
  }

  const events = must(
    await db().from("events").select("*").is("emailed_at", null).order("id").limit(2000),
    "unsent events"
  ) as EventRow[];
  if (!events.length && !first) {
    await saveRun(today, { email_sent_at: new Date().toISOString(), email_result: "no changes" });
    return "no changes — nothing sent";
  }

  const asins = await loadFamilies(events);
  const digest = buildDigest({
    date: today,
    events,
    asins,
    welcome: first ? await welcomeInfo() : undefined,
    appUrl: process.env.APP_URL,
  });
  const id = await sendEmail({ to, cc: recipients(process.env.ALERT_CC), ...digest });

  const ids = events.map((e) => e.id!);
  const sentAt = new Date().toISOString();
  for (let i = 0; i < ids.length; i += 200) {
    must(await db().from("events").update({ emailed_at: sentAt }).in("id", ids.slice(i, i + 200)), "mark emailed");
  }
  const outcome = first ? "welcome" : `sent (${events.length} changes)`;
  await saveRun(today, { email_sent_at: sentAt, email_result: outcome });
  log(`email ${id}: "${digest.subject}" → ${to.join(", ")}`);
  return outcome;
}

async function fetchAsins(list: string[], into: Map<string, AsinRow>) {
  const todo = [...new Set(list)].filter((a) => a && !into.has(a));
  for (let i = 0; i < todo.length; i += 200) {
    const rows = must(await db().from("asins").select("*").in("asin", todo.slice(i, i + 200)), "load asins") as AsinRow[];
    for (const r of rows) into.set(r.asin, r);
  }
}

/** Every ASIN an email needs: the changed ones, their parents, and their siblings. */
export async function loadFamilies(events: EventRow[]): Promise<Map<string, AsinRow>> {
  const map = new Map<string, AsinRow>();
  await fetchAsins(
    events.flatMap((e) => [e.asin, e.family_asin ?? "", e.details.new_parent ?? ""]),
    map
  );
  const families = new Set(events.map((e) => e.family_asin).filter(Boolean) as string[]);
  await fetchAsins(
    [...families].flatMap((f) => map.get(f)?.child_asins ?? []),
    map
  );
  return map;
}

async function countOf(q: PromiseLike<{ count: number | null; error: { message: string } | null }>, what: string) {
  const res = await q;
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.count ?? 0;
}

export async function trackingCounts() {
  const head = { count: "exact" as const, head: true };
  const [families, variations, listed] = await Promise.all([
    countOf(db().from("asins").select("asin", head).eq("is_parent", true).neq("child_asins", "{}"), "families"),
    countOf(db().from("asins").select("asin", head).eq("is_parent", false).not("parent_asin", "is", null), "variations"),
    countOf(db().from("asins").select("asin", head).eq("listed", true), "listed"),
  ]);
  return { families, variations, listed };
}

export async function welcomeInfo(): Promise<WelcomeInfo> {
  const totals = await trackingCounts();
  const kids = must(
    await db()
      .from("asins")
      .select("parent_asin, rating_count")
      .not("parent_asin", "is", null)
      .not("rating_count", "is", null)
      .order("rating_count", { ascending: false })
      .limit(500),
    "top families"
  ) as { parent_asin: string; rating_count: number }[];
  const top = new Map<string, number>();
  for (const k of kids) if (!top.has(k.parent_asin) && top.size < 10) top.set(k.parent_asin, k.rating_count);
  const parents = new Map<string, AsinRow>();
  await fetchAsins([...top.keys()], parents);
  return {
    ...totals,
    topFamilies: [...top]
      .filter(([p]) => parents.has(p))
      .map(([p, ratings]) => ({ parent: parents.get(p)!, variations: parents.get(p)!.child_asins.length, ratings })),
  };
}
