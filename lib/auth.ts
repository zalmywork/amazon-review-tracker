import { timingSafeEqual } from "node:crypto";

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; manual triggers use the same header. */
export function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return same(req.headers.get("authorization") ?? "", `Bearer ${secret}`);
}
