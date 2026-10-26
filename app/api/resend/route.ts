import { cronAuthorized } from "@/lib/auth";
import { db, must } from "@/lib/db";
import { buildDigest } from "@/lib/digest";
import { recipients, sendEmail } from "@/lib/mail";
import { loadFamilies } from "@/lib/run";
import { etDate, fmtDay } from "@/lib/time";
import type { EventRow } from "@/lib/types";

/**
 * Re-sends the alerts already emailed in the last ?days (default 7) to
 * ALERT_TO, as one email — for a new recipient catching up.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  const to = recipients(process.env.ALERT_TO);
  if (!to.length) return Response.json({ error: "ALERT_TO not set" }, { status: 400 });
  const days = Math.min(60, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 7));
  const since = etDate(new Date(Date.now() - days * 86_400_000));

  try {
    const events = (
      must(
        await db().from("events").select("*").gte("detected_on", since).not("emailed_at", "is", null).order("id").limit(2000),
        "recent events"
      ) as EventRow[]
    ).filter((e) => !e.type.startsWith("history_"));
    const digest = buildDigest({ date: etDate(), events, asins: await loadFamilies(events) });
    if (!digest.shown) return Response.json({ sent: false, reason: `no alerts since ${since}` });
    const subject = `Review alerts since ${fmtDay(since)}`;
    const id = await sendEmail({ to, ...digest, subject });
    return Response.json({ sent: id, to, subject, families: digest.shown });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
