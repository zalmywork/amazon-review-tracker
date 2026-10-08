import { cronAuthorized } from "@/lib/auth";
import { buildIntro } from "@/lib/intro";
import { recipients, sendEmail } from "@/lib/mail";
import { trackingCounts } from "@/lib/run";

/**
 * The intro email for the alert recipient. By default a [Draft] goes to
 * ADMIN_EMAIL for approval; ?final sends it to ALERT_TO.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  const url = new URL(req.url);
  const final = url.searchParams.has("final");
  const to = recipients(final ? process.env.ALERT_TO : process.env.ADMIN_EMAIL);
  if (!to.length) return Response.json({ error: `${final ? "ALERT_TO" : "ADMIN_EMAIL"} not set` }, { status: 400 });
  try {
    const email = buildIntro({
      siteUrl: url.origin,
      password: process.env.SITE_PASSWORD,
      counts: await trackingCounts(),
      draft: !final,
    });
    const id = await sendEmail({ to, ...email });
    return Response.json({ sent: id, to, subject: email.subject });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
