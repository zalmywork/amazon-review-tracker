const TZ = "America/New_York";

/** Today's date in New York as YYYY-MM-DD — the job's notion of "a day". */
export function etDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function etHour(d = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(d)
  );
}

/** "Oct 7, 3:10 PM ET" */
export function fmtEt(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(d) + " ET"
  );
}

/** "Oct 7" */
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" }).format(d);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
