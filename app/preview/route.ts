import { db, must } from "@/lib/db";
import { buildDigest } from "@/lib/digest";
import { loadFamilies, trackingCounts } from "@/lib/run";
import { asHistory, SAMPLE_WELCOME, sampleDigestData, sampleFromCatalog } from "@/lib/sample";
import { etDate } from "@/lib/time";
import type { AsinRow, EventRow } from "@/lib/types";

/**
 * The next email exactly as it would go out (changes not yet emailed; if
 * there are none, the last 14 days). ?sample shows our own products with made-up
 * changes, ?welcome the
 * first-day email.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const today = etDate();
  const wantWelcome = params.has("welcome");
  let sample = params.has("sample");
  let events: EventRow[] = [];
  let asins = new Map<string, AsinRow>();

  if (!sample) {
    events = must(
      await db().from("events").select("*").is("emailed_at", null).order("id").limit(2000),
      "unsent events"
    ) as EventRow[];
    if (!events.length) {
      const since = etDate(new Date(Date.now() - 14 * 86_400_000));
      events = must(
        await db().from("events").select("*").gte("detected_on", since).order("id").limit(2000),
        "recent events"
      ) as EventRow[];
    }
    if (events.length) asins = await loadFamilies(events);
    else sample = !wantWelcome;
  }
  if (sample) {
    ({ events, asins } = await sampleFromCatalog(today).catch(() => sampleDigestData(today)));
    if (wantWelcome) events = asHistory(events);
  }

  const welcome = wantWelcome ? (sample ? SAMPLE_WELCOME : await trackingCounts()) : undefined;
  const { html } = buildDigest({ date: today, events, asins, sample, welcome });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
