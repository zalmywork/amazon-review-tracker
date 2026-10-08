import { familiesNotSharing } from "@/lib/audit";
import { cronAuthorized } from "@/lib/auth";

/** Families whose variations aren't sharing one ratings count right now. */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  const families = await familiesNotSharing();
  return Response.json({ count: families.length, families });
}
