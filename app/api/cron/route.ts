import { cronAuthorized } from "@/lib/auth";
import { tick } from "@/lib/run";

export const maxDuration = 300;

/** Hourly (vercel.json). Each call advances today's check as far as it can in ~4 minutes. */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  try {
    return Response.json(await tick());
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
