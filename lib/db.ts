import { createClient } from "@supabase/supabase-js";

function make() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
  return createClient(url, key, {
    auth: { persistSession: false },
    db: { schema: "review_tracker" },
  });
}

let cached: ReturnType<typeof make> | null = null;

/** Server-side client (service role) pinned to the review_tracker schema. */
export function db() {
  cached ??= make();
  return cached;
}

/** Throw on a Supabase error, otherwise return the data. */
export function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}
