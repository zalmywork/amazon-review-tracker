import { connection } from "next/server";
import { db, must } from "@/lib/db";
import { keepaPending } from "@/lib/reviews";
import { imageCoverage, trackingCounts, type DailyRun } from "@/lib/run";
import { etDate, fmtDay, fmtEt } from "@/lib/time";
import type { EventRow } from "@/lib/types";

const CONFIG: [string, string[]][] = [
  ["Supabase", ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]],
  ["Amazon SP-API", ["LWA_CLIENT_ID", "LWA_CLIENT_SECRET", "LWA_REFRESH_TOKEN"]],
  ["Keepa", ["KEEPA_API_KEY"]],
  ["Email (Resend)", ["RESEND_API_KEY", "MAIL_FROM"]],
  ["Alert recipients", ["ALERT_TO"]],
  ["Cron secret", ["CRON_SECRET"]],
  ["Error alerts", ["ADMIN_EMAIL"]],
];

const LABEL: Record<string, string> = {
  left_family: "Split off",
  moved_family: "Moved family",
  joined_family: "Rejoined",
  ratings_drop: "Ratings drop",
  history_parent_change: "Split (before tracking)",
  history_ratings_drop: "Ratings drop (before tracking)",
};

function describe(e: EventRow): string {
  const d = e.details;
  if (e.type === "ratings_drop" || e.type === "history_ratings_drop") {
    return `${d.before?.toLocaleString()} → ${d.after?.toLocaleString()} ratings`;
  }
  if (e.type === "moved_family" || (e.type === "history_parent_change" && d.new_parent)) {
    return `${d.old_parent} → ${d.new_parent}`;
  }
  if (e.type === "joined_family") return `back under ${d.new_parent}`;
  return `left ${d.old_parent ?? e.family_asin}${d.family_dissolved ? " (family dissolved)" : ""}`;
}

async function load(today: string) {
  const client = db();
  const [counts, images, runs, events, pending] = await Promise.all([
    trackingCounts(),
    imageCoverage(),
    client.from("daily_runs").select("*").order("run_on", { ascending: false }).limit(10),
    client.from("events").select("*").order("id", { ascending: false }).limit(50),
    process.env.KEEPA_API_KEY ? keepaPending(today) : Promise.resolve(null),
  ]);
  return {
    counts,
    images,
    runs: must(runs, "runs") as DailyRun[],
    events: must(events, "events") as EventRow[],
    pending,
  };
}

const card = "rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900";
const th = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500";
const td = "px-3 py-2 align-top border-t border-zinc-100 dark:border-zinc-800";

export default async function Home() {
  await connection();
  const today = etDate();
  let data: Awaited<ReturnType<typeof load>> | null = null;
  let error: string | null = null;
  try {
    data = await load(today);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const run = data?.runs.find((r) => r.run_on === today);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 text-sm text-zinc-800 dark:text-zinc-200">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Amazon Review Tracker</h1>
          <p className="mt-1 text-zinc-500">
            Emails {process.env.ALERT_TO || "the alert list"} each morning when a variation splits off its family or a
            listing&apos;s ratings drop.
          </p>
        </div>
        <nav className="flex flex-wrap gap-2">
          {[
            ["/preview", "Next email"],
            ["/preview?sample", "Sample alert"],
            ["/preview?welcome", "First-day email"],
          ].map(([href, label]) => (
            <a
              key={href}
              href={href}
              className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              {label}
            </a>
          ))}
        </nav>
      </header>

      <section className={`${card} mb-6`}>
        <h2 className="mb-3 font-semibold">Setup</h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {CONFIG.map(([label, vars]) => {
            const ok = vars.every((v) => Boolean(process.env[v]));
            return (
              <li key={label} className="flex min-w-0 gap-2">
                <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${ok ? "bg-green-600" : "bg-amber-500"}`} />
                <div className="min-w-0">
                  <div className="font-medium">{label}</div>
                  <div className="break-all font-mono text-xs text-zinc-500">
                    {ok ? "set" : `missing ${vars.filter((v) => !process.env[v]).join(", ")}`}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {error && (
        <section className="mb-6 rounded-lg border border-red-300 bg-red-50 p-4 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <h2 className="font-semibold">Can&apos;t read the database</h2>
          <p className="mt-1 font-mono text-xs">{error}</p>
          <p className="mt-2">
            Run <code>supabase/schema.sql</code> in the Supabase SQL editor, then add <code>review_tracker</code> under
            Project Settings → Data API → Exposed schemas.
          </p>
        </section>
      )}

      {data && (
        <>
          <section className="mb-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[
              ["Variation families", data.counts.families],
              ["Variations watched", data.counts.variations],
              ["Your listings", data.counts.listed],
              ["Keepa reads left today", data.pending ?? "Keepa off"],
              ["Variations with images", `${data.images.withImage.toLocaleString()} / ${data.images.total.toLocaleString()}`],
            ].map(([label, value]) => (
              <div key={label} className={card}>
                <div className="text-xs text-zinc-500">{label}</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">
                  {typeof value === "number" ? value.toLocaleString() : value}
                </div>
              </div>
            ))}
          </section>

          <section className={`${card} mb-6`}>
            <h2 className="mb-3 font-semibold">Today ({fmtDay(today)})</h2>
            <ol className="grid gap-2 sm:grid-cols-4">
              {[
                ["1. Your listings", run?.listings_done_at],
                ["2. Family check (Amazon)", run?.catalog_done_at],
                ["3. Ratings (Keepa)", run?.keepa_done_at],
                ["4. Email", run?.email_sent_at],
              ].map(([label, at]) => (
                <li key={label} className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-800/50">
                  <div className="font-medium">{label}</div>
                  <div className={at ? "text-green-700 dark:text-green-400" : "text-zinc-500"}>
                    {at ? `Done ${fmtEt(at)}` : "Pending"}
                  </div>
                </li>
              ))}
            </ol>
            {run?.email_result && <p className="mt-3 text-zinc-500">Email: {run.email_result}</p>}
            {run?.last_error && (
              <p className="mt-3 rounded-md bg-red-50 p-2 font-mono text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
                Last error ({fmtEt(run.last_error_at)}): {run.last_error}
              </p>
            )}
          </section>

          <section className={`${card} mb-6 overflow-x-auto p-0`}>
            <h2 className="px-4 pt-4 font-semibold">Recent changes</h2>
            {data.events.length === 0 ? (
              <p className="px-4 pb-4 pt-2 text-zinc-500">Nothing yet. The first day only records a baseline.</p>
            ) : (
              <table className="mt-2 w-full">
                <thead>
                  <tr>
                    <th className={th}>Found</th>
                    <th className={th}>Change</th>
                    <th className={th}>ASIN</th>
                    <th className={th}>Details</th>
                    <th className={th}>Emailed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((e) => (
                    <tr key={e.id}>
                      <td className={td}>{fmtDay(e.detected_on)}</td>
                      <td className={td}>{LABEL[e.type] ?? e.type}</td>
                      <td className={`${td} font-mono`}>
                        <a className="text-blue-700 hover:underline dark:text-blue-400" href={`https://www.amazon.com/dp/${e.asin}`}>
                          {e.asin}
                        </a>
                      </td>
                      <td className={td}>{describe(e)}</td>
                      <td className={`${td} text-zinc-500`}>{e.emailed_at ? fmtDay(e.emailed_at) : "Not yet"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className={`${card} overflow-x-auto p-0`}>
            <h2 className="px-4 pt-4 font-semibold">Daily runs</h2>
            <table className="mt-2 w-full">
              <thead>
                <tr>
                  <th className={th}>Day</th>
                  <th className={th}>Listings</th>
                  <th className={th}>Catalog checks</th>
                  <th className={th}>Keepa reads</th>
                  <th className={th}>Changes</th>
                  <th className={th}>Email</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.run_on}>
                    <td className={td}>{fmtDay(r.run_on)}</td>
                    <td className={`${td} tabular-nums`}>{String(r.stats.listed ?? "–")}</td>
                    <td className={`${td} tabular-nums`}>{String(r.stats.catalog_checked ?? "–")}</td>
                    <td className={`${td} tabular-nums`}>{String(r.stats.keepa_checked ?? "–")}</td>
                    <td className={`${td} tabular-nums`}>
                      {Number(r.stats.family_changes ?? 0) + Number(r.stats.ratings_changes ?? 0)}
                    </td>
                    <td className={td}>
                      {r.email_result ?? "–"}
                      {r.last_error && <div className="text-xs text-red-700 dark:text-red-400">error: {r.last_error.slice(0, 120)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}
