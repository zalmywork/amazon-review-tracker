import { cronAuthorized } from "@/lib/auth";
import { buildDigest } from "@/lib/digest";
import { recipients, sendEmail } from "@/lib/mail";
import { asHistory, sampleDigestData, sampleWelcome } from "@/lib/sample";
import { etDate } from "@/lib/time";

/** Sends the sample alert to ADMIN_EMAIL only (never to Sara) to check Resend is set up. */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  const to = recipients(process.env.ADMIN_EMAIL);
  if (!to.length) return Response.json({ error: "ADMIN_EMAIL not set" }, { status: 400 });
  const today = etDate();
  const welcome = new URL(req.url).searchParams.has("welcome");
  const { events, asins } = sampleDigestData(today);
  const digest = buildDigest({
    date: today,
    events: welcome ? asHistory(events) : events,
    asins,
    sample: true,
    welcome: welcome ? sampleWelcome(asins) : undefined,
    appUrl: process.env.APP_URL,
  });
  try {
    const id = await sendEmail({ to, ...digest });
    return Response.json({ sent: id, to, subject: digest.subject });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
