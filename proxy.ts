import { NextResponse, type NextRequest } from "next/server";

/**
 * Password gate for the status page and email preview (HTTP basic auth, any
 * username). API routes guard themselves with CRON_SECRET.
 */
export function proxy(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();
  const password = process.env.SITE_PASSWORD;
  if (!password) {
    return new NextResponse("Set SITE_PASSWORD in the Vercel project's environment variables to open this page.", {
      status: 503,
    });
  }
  const [scheme, encoded] = (req.headers.get("authorization") ?? "").split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = atob(encoded);
    if (sameText(decoded.slice(decoded.indexOf(":") + 1), password)) return NextResponse.next();
  }
  return new NextResponse("Password required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Review tracker"' },
  });
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
