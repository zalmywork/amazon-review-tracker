import { db, must } from "./db";
import type { EventRow } from "./types";

/** Record events; the same change found twice in one day is stored once. */
export async function recordEvents(events: EventRow[]): Promise<void> {
  if (events.length === 0) return;
  must(
    await db()
      .from("events")
      .upsert(events, { onConflict: "detected_on,type,asin,family_asin", ignoreDuplicates: true }),
    "events insert"
  );
}
