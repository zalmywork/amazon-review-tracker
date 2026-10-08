import { fmtDay } from "./time";
import type { AsinRow, EventDetails, EventRow } from "./types";

/**
 * The alert email: one short card per product family — what happened, and
 * the ratings before → after for the variations involved. Nothing else.
 */

export interface WelcomeInfo {
  families: number;
  variations: number;
  listed: number;
}

export interface DigestInput {
  date: string;
  events: EventRow[];
  asins: Map<string, AsinRow>;
  welcome?: WelcomeInfo;
  sample?: boolean;
}

type Status = "split" | "moved" | "removed" | "rejoined" | "in family";

interface Member {
  asin: string;
  status: Status;
  drop?: EventDetails;
}

interface Group {
  familyAsin: string | null;
  dissolved: boolean;
  members: Map<string, Member>;
  date: string;
}

/** Keepa's marker for "no parent" in parent history. */
const NO_PARENT = "-1";

const C = {
  text: "#111827",
  muted: "#6b7280",
  border: "#e5e7eb",
  soft: "#f9fafb",
  red: "#b91c1c",
  redSoft: "#fef2f2",
  green: "#15803d",
  greenSoft: "#f0fdf4",
  link: "#111827",
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const esc = (s: string | null | undefined) =>
  (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const n = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toLocaleString("en-US"));
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const amazonUrl = (asin: string) => `https://www.amazon.com/dp/${asin}`;
const hasDrop = (d?: EventDetails) => d?.before !== undefined && d.after !== undefined;

function shortName(title: string | null | undefined): string | null {
  if (!title) return null;
  const head = title.split(/,| \| | - /)[0].trim();
  return head.length > 60 ? `${head.slice(0, 59)}…` : head;
}

function familyName(g: Group, asins: Map<string, AsinRow>): string {
  const parent = g.familyAsin ? asins.get(g.familyAsin) : undefined;
  const title = parent?.title ?? [...g.members.keys()].map((a) => asins.get(a)?.title).find(Boolean);
  return shortName(title) ?? g.familyAsin ?? "Product";
}

const memberName = (asin: string, asins: Map<string, AsinRow>) => {
  const row = asins.get(asin);
  return row?.variation_label ?? shortName(row?.title) ?? asin;
};

// ---------- grouping ----------

function groupEvents(events: EventRow[], history: boolean): Group[] {
  const groups = new Map<string, Group>();
  for (const e of events) {
    if (e.type.startsWith("history_") !== history) continue;
    if (e.family_asin === NO_PARENT || e.details.old_parent === NO_PARENT) continue;
    const key = e.family_asin ?? `solo:${e.asin}`;
    const date = e.details.changed_at ?? e.detected_on;
    const g = groups.get(key) ?? { familyAsin: e.family_asin, dissolved: false, members: new Map(), date };
    groups.set(key, g);
    if (date < g.date) g.date = date;
    const m = g.members.get(e.asin) ?? { asin: e.asin, status: "in family" as Status };
    g.members.set(e.asin, m);

    if (e.type === "ratings_drop" || e.type === "history_ratings_drop") m.drop = e.details;
    else if (e.type === "joined_family") m.status = "rejoined";
    else if (e.details.child_missing) m.status = "removed";
    else if (e.type === "moved_family" || (e.type === "history_parent_change" && e.details.new_parent)) m.status = "moved";
    else if (e.type === "left_family" || e.type === "history_parent_change") m.status = "split";
    if (e.details.family_dissolved) g.dissolved = true;
  }

  const out: Group[] = [];
  for (const g of groups.values()) {
    // A move with no ratings drop anywhere in the family is a re-parent: the reviews came along.
    if (![...g.members.values()].some((m) => m.drop)) {
      for (const [asin, m] of g.members) if (m.status === "moved") g.members.delete(asin);
    }
    if ([...g.members.values()].some((m) => m.status !== "in family" || m.drop)) out.push(g);
  }
  const rank = (g: Group) => (splits(g).length ? 0 : [...g.members.values()].some((m) => m.drop) ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

const splits = (g: Group) =>
  [...g.members.values()].filter((m) => m.status === "split" || m.status === "moved" || m.status === "removed");
const stayed = (g: Group) => [...g.members.values()].filter((m) => m.status === "in family" && hasDrop(m.drop));
const rejoined = (g: Group) => [...g.members.values()].filter((m) => m.status === "rejoined");

/** Variations still in the family no longer show one shared count. */
function unpooled(g: Group): boolean {
  const afters = stayed(g).map((m) => m.drop!.after!);
  if (afters.length < 2) return false;
  const hi = Math.max(...afters);
  return hi - Math.min(...afters) > Math.max(2, hi * 0.02);
}

const isProblem = (g: Group) => splits(g).length > 0 || stayed(g).length > 0;

function summary(g: Group, asins: Map<string, AsinRow>): string {
  const s = splits(g);
  if (g.dissolved) return "Family dissolved";
  if (s.length === 1) {
    const name = memberName(s[0].asin, asins);
    if (s[0].status === "removed") return `${name} removed from catalog`;
    if (s[0].status === "moved") return `${name} moved to another parent`;
    return `${name} split from family`;
  }
  if (s.length > 1) return `${plural(s.length, "variation")} split from family`;
  if (stayed(g).length) {
    if (unpooled(g)) return "Reviews no longer shared";
    const top = stayed(g).map((m) => m.drop!).sort((a, b) => b.before! - a.before!)[0];
    return `${n(top.before! - top.after!)} ratings removed`;
  }
  const r = rejoined(g);
  return r.length === 1 ? `${memberName(r[0].asin, asins)} rejoined family` : `${plural(r.length, "variation")} rejoined family`;
}

// ---------- rows ----------

interface Row {
  asin: string;
  label: string;
  pill?: { text: string; fg: string; bg: string };
  single: boolean;
  drop?: EventDetails;
}

function rows(g: Group, asins: Map<string, AsinRow>): Row[] {
  const out: Row[] = [];
  const pills: Partial<Record<Status, Row["pill"]>> = {
    split: { text: "Split", fg: C.red, bg: C.redSoft },
    moved: { text: "Moved", fg: C.red, bg: C.redSoft },
    removed: { text: "Removed", fg: C.red, bg: C.redSoft },
    rejoined: { text: "Rejoined", fg: C.green, bg: C.greenSoft },
  };
  for (const m of [...splits(g), ...rejoined(g)]) {
    out.push({ asin: m.asin, label: memberName(m.asin, asins), pill: pills[m.status], single: true, drop: m.drop });
  }
  const rest = stayed(g);
  if (unpooled(g) || rest.length === 1) {
    for (const m of rest.sort((a, b) => a.drop!.after! - b.drop!.after!)) {
      out.push({ asin: m.asin, label: memberName(m.asin, asins), single: true, drop: m.drop });
    }
  } else if (rest.length > 1) {
    out.push({
      asin: rest[0].asin,
      label: splits(g).length ? `${rest.length} remaining variations` : `All ${rest.length} variations`,
      single: false,
      drop: rest[0].drop,
    });
  }
  return out;
}

function rowHtml(r: Row, asins: Map<string, AsinRow>): string {
  const row = asins.get(r.asin);
  const td = `padding:10px 0;border-top:1px solid ${C.border};vertical-align:middle`;
  const img = row?.image_url
    ? `<img src="${esc(row.image_url)}" width="40" height="40" alt="" style="display:block;width:40px;height:40px;object-fit:contain;border-radius:4px;background:#fff">`
    : "";
  const pill = r.pill
    ? ` <span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:9px;font-size:11px;font-weight:600;color:${r.pill.fg};background:${r.pill.bg};vertical-align:1px">${r.pill.text}</span>`
    : "";
  const sub = r.single
    ? `<div style="font-size:12px;color:${C.muted};margin-top:2px"><a href="${amazonUrl(r.asin)}" style="color:${C.muted}">${esc(r.asin)}</a>${row?.skus?.length ? ` · ${esc(row.skus[0])}` : ""}</div>`
    : "";
  const ratings = hasDrop(r.drop)
    ? `<span style="color:${C.muted}">${n(r.drop!.before)}</span> → <b style="color:${C.red}">${n(r.drop!.after)}</b>`
    : `<span style="color:${C.muted}">${n(row?.rating_count)}</span>`;
  return `<tr>
    <td style="${td};width:52px">${img}</td>
    <td style="${td};font-size:14px;color:${C.text}"><span style="font-weight:600">${esc(r.label)}</span>${pill}${sub}</td>
    <td style="${td};text-align:right;white-space:nowrap;font-size:14px;color:${C.text}">${ratings}</td>
  </tr>`;
}

function cardHtml(g: Group, asins: Map<string, AsinRow>): string {
  const name = esc(familyName(g, asins));
  const title = g.familyAsin
    ? `<a href="${amazonUrl(g.familyAsin)}" style="color:${C.text};text-decoration:none">${name}</a>`
    : name;
  const color = isProblem(g) ? C.red : C.green;
  return `
  <div style="border:1px solid ${C.border};border-radius:8px;padding:16px 16px 6px;margin:0 0 16px">
    <div style="font-size:16px;font-weight:600;color:${C.text}">${title}</div>
    <div style="font-size:14px;margin-top:4px"><span style="color:${color};font-weight:600">${esc(summary(g, asins))}</span><span style="color:${C.muted}"> · ${esc(fmtDay(g.date))}</span></div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:12px">
      <tr><td></td><td></td><td style="padding:0 0 6px;text-align:right;font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:.05em">Ratings</td></tr>
      ${rows(g, asins).map((r) => rowHtml(r, asins)).join("")}
    </table>
  </div>`;
}

// ---------- assemble ----------

export function buildDigest(input: DigestInput): { subject: string; html: string; text: string; shown: number } {
  const { asins } = input;
  const live = groupEvents(input.events, false);
  const past = groupEvents(input.events, true);
  const problems = live.filter(isProblem);

  let subject: string;
  if (input.welcome) subject = "Review tracking is live";
  else if (live.length === 1) {
    subject = `${isProblem(live[0]) ? "Review alert" : "Review update"}: ${summary(live[0], asins)} – ${familyName(live[0], asins)}`;
  } else if (problems.length) subject = `Review alert: ${plural(problems.length, "product family", "product families")} affected`;
  else if (live.length) subject = `Review update: ${plural(live.length, "family", "families")} rejoined`;
  else subject = "Review update";
  if (input.sample) subject = `[Sample] ${subject}`;

  const heading = input.welcome ? "Review tracking is live" : problems.length ? "Review alert" : "Review update";
  const needsFix = problems.length > 0 || past.some(isProblem);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:${FONT}">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px">
    ${input.sample ? `<div style="padding:8px 12px;margin:0 0 16px;border-radius:6px;background:${C.soft};color:${C.muted};font-size:12px">Sample data</div>` : ""}
    <div style="font-size:20px;font-weight:700;color:${C.text}">${heading}</div>
    <div style="font-size:13px;color:${C.muted};margin:2px 0 20px">${esc(fmtDay(input.date))}</div>
    ${
      input.welcome
        ? `<p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:${C.text}">Monitoring ${n(input.welcome.families)} product families (${n(input.welcome.variations)} variations). You'll receive an email only when reviews split.</p>`
        : ""
    }
    ${live.map((g) => cardHtml(g, asins)).join("")}
    ${past.length ? `<div style="font-size:13px;font-weight:600;color:${C.muted};text-transform:uppercase;letter-spacing:.05em;margin:8px 0 12px">Last 60 days</div>${past.map((g) => cardHtml(g, asins)).join("")}` : ""}
    ${needsFix ? `<p style="margin:4px 0 0;font-size:13px;line-height:1.5;color:${C.text}">To fix: re-attach the variation in Variation Wizard, or ask Seller Support to re-merge reviews.</p>` : ""}
    <p style="margin:24px 0 0;font-size:12px;color:${C.muted}">Daily review check · Ratings via Keepa</p>
  </div>
</body></html>`;

  return { subject, html, text: toText(heading, live, past, input, needsFix), shown: live.length + past.length };
}

function toText(heading: string, live: Group[], past: Group[], input: DigestInput, needsFix: boolean): string {
  const { asins } = input;
  const lines: string[] = [`${heading} – ${fmtDay(input.date)}`, ""];
  if (input.welcome) {
    lines.push(
      `Monitoring ${n(input.welcome.families)} product families (${n(input.welcome.variations)} variations). You'll receive an email only when reviews split.`,
      ""
    );
  }
  const card = (g: Group) => {
    lines.push(familyName(g, asins), `${summary(g, asins)} (${fmtDay(g.date)})`);
    for (const r of rows(g, asins)) {
      const ratings = hasDrop(r.drop) ? `${n(r.drop!.before)} → ${n(r.drop!.after)}` : n(asins.get(r.asin)?.rating_count);
      lines.push(`- ${r.label}${r.single ? ` (${r.asin})` : ""}: ${ratings} ratings`);
    }
    lines.push("");
  };
  live.forEach(card);
  if (past.length) {
    lines.push("LAST 60 DAYS", "");
    past.forEach(card);
  }
  if (needsFix) lines.push("To fix: re-attach the variation in Variation Wizard, or ask Seller Support to re-merge reviews.");
  return lines.join("\n").trim();
}
