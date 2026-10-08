import { fmtDay, fmtEt } from "./time";
import type { AsinRow, EventDetails, EventRow } from "./types";

/**
 * Builds the email Sara gets: one section per affected variation family,
 * each with what happened in plain English, the ratings before/after, and a
 * row per variation so she can see exactly which listing split off.
 */

export interface WelcomeInfo {
  families: number;
  variations: number;
  listed: number;
  topFamilies: { parent: AsinRow; variations: number; ratings: number | null }[];
}

export interface DigestInput {
  date: string;
  events: EventRow[];
  asins: Map<string, AsinRow>;
  welcome?: WelcomeInfo;
  appUrl?: string;
  sample?: boolean;
}

type Status = "split" | "moved" | "rejoined" | "in family";

interface Member {
  asin: string;
  status: Status;
  movedTo?: string | null;
  missing?: boolean;
  drop?: EventDetails;
}

interface Group {
  familyAsin: string | null;
  history: boolean;
  dissolved: boolean;
  members: Map<string, Member>;
  changedAt: string | null;
}

const MAX_ROWS = 30;

// ---------- formatting ----------

const esc = (s: string | null | undefined) =>
  (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const n = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toLocaleString("en-US"));
const stars = (v: number | null | undefined) => (v === null || v === undefined ? "–" : Number(v).toFixed(1));
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const trunc = (s: string, len: number) => (s.length > len ? `${s.slice(0, len - 1)}…` : s);
const amazonUrl = (asin: string) => `https://www.amazon.com/dp/${asin}`;
const pct = (before: number, after: number) => (before > 0 ? Math.round(((before - after) / before) * 100) : 0);
const listJoin = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const C = {
  text: "#1f2937",
  muted: "#6b7280",
  border: "#e5e7eb",
  soft: "#f9fafb",
  red: "#b91c1c",
  redSoft: "#fef2f2",
  green: "#15803d",
  amber: "#92400e",
  amberSoft: "#fffbeb",
  link: "#1d4ed8",
};

function familyName(g: Group, asins: Map<string, AsinRow>): string {
  const parent = g.familyAsin ? asins.get(g.familyAsin) : undefined;
  const title =
    parent?.title ??
    [...g.members.keys()].map((a) => asins.get(a)?.title).find(Boolean) ??
    (g.familyAsin ? `Family ${g.familyAsin}` : "Listing not in a family");
  return trunc(title, 90);
}

function memberName(asin: string, asins: Map<string, AsinRow>): string {
  const row = asins.get(asin);
  return row?.variation_label ?? (row?.title ? trunc(row.title, 60) : asin);
}

// ---------- grouping ----------

function groupEvents(events: EventRow[], asins: Map<string, AsinRow>, history: boolean): Group[] {
  const groups = new Map<string, Group>();
  for (const e of events) {
    if (e.type.startsWith("history_") !== history) continue;
    const key = e.family_asin ?? `solo:${e.asin}`;
    const g =
      groups.get(key) ??
      ({ familyAsin: e.family_asin, history, dissolved: false, members: new Map(), changedAt: null } as Group);
    groups.set(key, g);
    const m = g.members.get(e.asin) ?? { asin: e.asin, status: "in family" as Status };
    g.members.set(e.asin, m);

    if (e.type === "moved_family" || (e.type === "history_parent_change" && e.details.new_parent)) {
      m.status = "moved";
      m.movedTo = e.details.new_parent;
    } else if ((e.type === "left_family" || e.type === "history_parent_change") && m.status !== "moved") {
      m.status = "split";
    } else if (e.type === "joined_family") {
      m.status = "rejoined";
    } else if (e.type === "ratings_drop" || e.type === "history_ratings_drop") {
      m.drop = e.details;
    }
    if (e.details.child_missing) m.missing = true;
    if (e.details.family_dissolved) g.dissolved = true;
    const at = e.details.changed_at;
    if (at && (!g.changedAt || at < g.changedAt)) g.changedAt = at;
  }

  // Show the rest of the family too, so it's clear what's still attached.
  if (!history) {
    for (const g of groups.values()) {
      const parent = g.familyAsin ? asins.get(g.familyAsin) : undefined;
      for (const child of parent?.child_asins ?? []) {
        if (!g.members.has(child)) g.members.set(child, { asin: child, status: "in family" });
      }
    }
  }

  const severity = (g: Group) =>
    [...g.members.values()].some((m) => m.status === "split" || m.status === "moved")
      ? 0
      : [...g.members.values()].some((m) => m.drop)
        ? 1
        : 2;
  return [...groups.values()].sort((a, b) => severity(a) - severity(b));
}

function counts(g: Group) {
  const ms = [...g.members.values()];
  return {
    split: ms.filter((m) => m.status === "split" || m.status === "moved"),
    rejoined: ms.filter((m) => m.status === "rejoined"),
    dropsInFamily: ms.filter((m) => m.drop && m.status !== "split" && m.status !== "moved"),
    dropsSplit: ms.filter((m) => m.drop && (m.status === "split" || m.status === "moved")),
  };
}

function headline(g: Group): string {
  const c = counts(g);
  if (g.dissolved) return `Family broken up — every variation is now a separate listing`;
  if (c.split.length) return `${plural(c.split.length, "variation")} split off this family`;
  if (c.dropsInFamily.length)
    return `Ratings dropped on ${plural(c.dropsInFamily.length, "variation")} — family still intact`;
  if (c.rejoined.length) return `${plural(c.rejoined.length, "variation")} rejoined this family`;
  return "Family change";
}

function sentences(g: Group, asins: Map<string, AsinRow>): string[] {
  const c = counts(g);
  const out: string[] = [];
  const inFamily = c.dropsInFamily
    .map((m) => m.drop!)
    .filter((d) => d.before !== undefined && d.after !== undefined);
  if (inFamily.length) {
    const before = Math.max(...inFamily.map((d) => d.before!));
    const afters = inFamily.map((d) => d.after!).sort((a, b) => b - a);
    const shared = afters[0] - afters.at(-1)! <= Math.max(2, afters[0] * 0.02);
    out.push(
      shared
        ? `Listings still in this family now show <b>${n(afters[0])}</b> ratings, down from ${n(before)} ` +
            `(<span style="color:${C.red}">−${n(before - afters[0])}, −${pct(before, afters[0])}%</span>).`
        : `These variations used to all show <b>${n(before)}</b> ratings. Now each shows a different, smaller count — ` +
            `${listJoin([
              ...afters.slice(0, 5).map((a) => `<b>${n(a)}</b>`),
              ...(afters.length > 5 ? [`${afters.length - 5} more`] : []),
            ])} — so they're no longer sharing one pool of reviews.`
    );
  }
  for (const m of c.split) {
    const name = `<b>${esc(memberName(m.asin, asins))}</b> (${esc(m.asin)})`;
    const where =
      m.status === "moved" && m.movedTo
        ? `now sits under a different parent, ${esc(m.movedTo)}`
        : m.missing
          ? "has dropped out of Amazon's catalog entirely (the listing may have been deleted or suppressed)"
          : "is no longer attached to this family";
    const impact =
      m.drop?.before !== undefined && m.drop.after !== undefined
        ? ` It now shows <b>${n(m.drop.after)}</b> ratings on its own, down from ${n(m.drop.before)}.`
        : "";
    out.push(`${name} ${where}.${impact}`);
  }
  for (const m of c.rejoined) {
    out.push(`<b>${esc(memberName(m.asin, asins))}</b> (${esc(m.asin)}) is back under this family's parent.`);
  }
  if (c.split.length && !c.dropsSplit.length && !c.dropsInFamily.length && !g.history) {
    out.push(
      `<span style="color:${C.muted}">Keepa hasn't refreshed these listings' ratings yet — the review impact will show in the next email if counts fall.</span>`
    );
  }
  if (!c.split.length && c.dropsInFamily.length) {
    out.push(
      `Amazon's catalog still lists every variation under the same parent, so this usually means Amazon stopped sharing reviews between these variations, or removed a batch of reviews.`
    );
  }
  return out;
}

// ---------- HTML ----------

function statusPill(m: Member, asins: Map<string, AsinRow>): string {
  const pill = (text: string, fg: string, bg: string) =>
    ` <span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600;color:${fg};background:${bg};white-space:nowrap;vertical-align:1px">${text}</span>`;
  switch (m.status) {
    case "split":
      return pill(m.missing ? "Gone from catalog" : "Split off", C.red, C.redSoft);
    case "moved":
      return pill(m.movedTo ? `Moved to ${esc(m.movedTo)}` : "Moved", C.red, C.redSoft);
    case "rejoined":
      return pill("Rejoined", C.green, "#f0fdf4");
    default:
      if (m.drop) return pill("Ratings fell", C.amber, C.amberSoft);
      return asins.get(m.asin)?.catalog_found === false ? pill("Not in catalog", C.muted, C.soft) : "";
  }
}

/** Three columns so a row still fits a phone screen. */
function memberRow(m: Member, asins: Map<string, AsinRow>): string {
  const row = asins.get(m.asin);
  const td = `padding:8px 6px;border-top:1px solid ${C.border};vertical-align:top;font-size:13px;color:${C.text}`;
  const small = `font-size:11px;color:${C.muted};line-height:1.5`;
  const img = row?.image_url
    ? `<img src="${esc(row.image_url)}" width="40" height="40" alt="" style="display:block;width:40px;height:40px;object-fit:contain;border:1px solid ${C.border};border-radius:4px;background:#fff">`
    : `<div style="width:40px;height:40px;border:1px solid ${C.border};border-radius:4px;background:${C.soft}"></div>`;
  const label = row?.variation_label ?? (row?.title ? trunc(row.title, 50) : "");
  const skus = row?.skus?.length ? `SKU ${esc(row.skus.slice(0, 2).join(", "))}${row.skus.length > 2 ? "…" : ""}` : "";
  const d = m.drop;
  const ratings =
    d?.before !== undefined && d.after !== undefined
      ? `<span style="color:${C.muted};text-decoration:line-through">${n(d.before)}</span> → <b style="color:${C.red}">${n(d.after)}</b>`
      : n(row?.rating_count);
  const starText =
    d && d.rating_before !== undefined && d.rating_before !== null && d.rating_before !== d.rating_after
      ? `${stars(d.rating_before)} → ${stars(d.rating_after)} stars`
      : `${stars(d?.rating_after ?? row?.rating)} stars`;
  const own = d?.own_reviews ?? row?.own_review_count;
  const asOf = d?.keepa_as_of ?? row?.keepa_rating_at;
  const detail = [starText, own !== null && own !== undefined ? `${n(own)} own` : null, asOf ? `as of ${esc(fmtDay(asOf))}` : null]
    .filter(Boolean)
    .join(" · ");
  return `<tr>
    <td style="${td};width:44px">${img}</td>
    <td style="${td}">
      <div style="font-weight:600">${esc(label || m.asin)}${statusPill(m, asins)}</div>
      <div style="${small}"><a href="${amazonUrl(m.asin)}" style="color:${C.link}">${esc(m.asin)}</a>${skus ? ` · ${skus}` : ""}</div>
    </td>
    <td style="${td};text-align:right">
      <div style="white-space:nowrap">${ratings}</div>
      <div style="${small}">${detail}</div>
    </td>
  </tr>`;
}

function groupHtml(g: Group, asins: Map<string, AsinRow>, detectedOn: string): string {
  const parent = g.familyAsin ? asins.get(g.familyAsin) : undefined;
  const order: Record<Status, number> = { split: 0, moved: 0, rejoined: 1, "in family": 2 };
  const members = [...g.members.values()].sort(
    (a, b) => order[a.status] - order[b.status] || Number(Boolean(b.drop)) - Number(Boolean(a.drop)) || a.asin.localeCompare(b.asin)
  );
  const shown = members.slice(0, MAX_ROWS);
  const hidden = members.length - shown.length;
  const th = `padding:6px;font-size:11px;font-weight:600;color:${C.muted};text-transform:uppercase;letter-spacing:.03em;text-align:left`;
  const when = [
    g.history ? null : `Found by the daily check on ${fmtDay(detectedOn)}`,
    g.changedAt ? `Keepa saw the change around ${fmtEt(g.changedAt)}` : null,
  ].filter(Boolean);
  const meta = [
    g.familyAsin ? `Parent <a href="${amazonUrl(g.familyAsin)}" style="color:${C.link}">${esc(g.familyAsin)}</a>` : null,
    parent?.variation_theme ? `varies by ${esc(parent.variation_theme.toLowerCase().replace(/_name/g, "").replace(/_/g, " "))}` : null,
    parent?.child_asins ? `${plural(parent.child_asins.length, "variation")} attached now` : null,
  ].filter(Boolean);

  return `
  <div style="border:1px solid ${C.border};border-radius:8px;margin:0 0 20px;overflow:hidden">
    <div style="padding:14px 16px;background:${C.soft};border-bottom:1px solid ${C.border}">
      <div style="font-size:15px;font-weight:700;color:${C.text}">${esc(headline(g))}</div>
      <div style="font-size:13px;color:${C.text};margin-top:4px">${esc(familyName(g, asins))}</div>
      <div style="font-size:12px;color:${C.muted};margin-top:4px">${meta.join(" · ")}</div>
    </div>
    <div style="padding:12px 16px 4px">
      ${sentences(g, asins).map((s) => `<p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:${C.text}">${s}</p>`).join("")}
      ${when.length ? `<p style="margin:0 0 8px;font-size:12px;color:${C.muted}">${when.join(" · ")}</p>` : ""}
    </div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">
      <tr><th style="${th}"></th><th style="${th}">Variation</th><th style="${th};text-align:right">Ratings shown</th></tr>
      ${shown.map((m) => memberRow(m, asins)).join("")}
    </table>
    ${hidden > 0 ? `<div style="padding:8px 16px;font-size:12px;color:${C.muted}">…and ${plural(hidden, "more unchanged variation")}</div>` : ""}
  </div>`;
}

const WHAT_TO_DO = `
  <div style="border:1px solid ${C.border};border-radius:8px;padding:14px 16px;margin:0 0 20px;background:${C.soft}">
    <div style="font-size:14px;font-weight:700;color:${C.text};margin-bottom:6px">What to do</div>
    <ol style="margin:0;padding-left:18px;font-size:13px;line-height:1.6;color:${C.text}">
      <li>Open the parent ASIN in Seller Central (Manage All Inventory or the Variation Wizard) and check whether the variation is still attached.</li>
      <li>If a variation was dropped, re-attach it to the parent with the same variation theme.</li>
      <li>If the family is intact but ratings fell, open a Seller Support case asking Amazon to re-merge reviews across the ASINs listed above.</li>
    </ol>
  </div>`;

function welcomeHtml(w: WelcomeInfo): string {
  const td = `padding:6px;border-top:1px solid ${C.border};font-size:13px;color:${C.text}`;
  return `
  <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:${C.text}">
    The review tracker is now watching <b>${n(w.families)}</b> variation families (${n(w.variations)} variations) across ${n(w.listed)} of your listings.
    Every morning it checks Amazon's catalog for variations that split off their family, and Keepa for listings whose ratings dropped.
    You'll only get an email when something changed — no email means nothing fell off.
  </p>
  ${
    w.topFamilies.length
      ? `<div style="border:1px solid ${C.border};border-radius:8px;margin:0 0 20px;overflow:hidden">
    <div style="padding:10px 16px;background:${C.soft};font-size:13px;font-weight:700;color:${C.text}">Largest families being watched</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">
      ${w.topFamilies
        .map(
          (f) => `<tr>
        <td style="${td}"><a href="${amazonUrl(f.parent.asin)}" style="color:${C.link}">${esc(trunc(f.parent.title ?? f.parent.asin, 70))}</a></td>
        <td style="${td};text-align:right;white-space:nowrap">${plural(f.variations, "variation")}</td>
        <td style="${td};text-align:right;white-space:nowrap">${n(f.ratings)} ratings</td>
      </tr>`
        )
        .join("")}
    </table>
  </div>`
      : ""
  }`;
}

export function buildDigest(input: DigestInput): { subject: string; html: string; text: string; problems: number } {
  const { asins } = input;
  const live = groupEvents(input.events, asins, false);
  const past = groupEvents(input.events, asins, true);
  const problems = live.filter((g) => counts(g).split.length || counts(g).dropsInFamily.length).length;
  const rejoins = live.reduce((sum, g) => sum + counts(g).rejoined.length, 0);

  let subject: string;
  if (input.welcome) {
    subject = `Review tracker is live — watching ${plural(input.welcome.families, "variation family", "variation families")}`;
  } else if (problems === 1 && live.length === 1 && counts(live[0]).split.length === 1) {
    const m = counts(live[0]).split[0];
    const drop = m.drop?.before !== undefined && m.drop.after !== undefined ? ` (${n(m.drop.before)} → ${n(m.drop.after)} ratings)` : "";
    subject = `Review alert: ${memberName(m.asin, asins)} split off its family${drop}`;
  } else if (problems > 0) {
    subject = `Review alert: ${plural(problems, "variation family", "variation families")} lost shared reviews`;
  } else if (rejoins > 0) {
    subject = `Review update: ${plural(rejoins, "variation")} rejoined ${rejoins === 1 ? "its family" : "their families"}`;
  } else {
    subject = `Review tracker: changes found in Keepa history`;
  }
  if (input.sample) subject = `[Sample] ${subject}`;

  const intro =
    !input.welcome && live.length > 1
      ? `<ul style="margin:0 0 16px;padding-left:18px;font-size:14px;line-height:1.6;color:${C.text}">${live
          .map((g) => `<li><b>${esc(headline(g))}</b> — ${esc(familyName(g, asins))}</li>`)
          .join("")}</ul>`
      : "";

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:680px;margin:0 auto;padding:24px 16px">
    ${input.sample ? `<div style="padding:10px 14px;margin:0 0 16px;border-radius:6px;background:${C.amberSoft};color:${C.amber};font-size:13px"><b>Sample email.</b> These ASINs are made up — this is what an alert looks like.</div>` : ""}
    <div style="font-size:12px;color:${C.muted};text-transform:uppercase;letter-spacing:.05em">Amazon review tracker · ${esc(fmtDay(input.date))}</div>
    <h1 style="margin:4px 0 16px;font-size:20px;line-height:1.3;color:${C.text}">${esc(subject.replace(/^\[Sample\] /, ""))}</h1>
    ${input.welcome ? welcomeHtml(input.welcome) : ""}
    ${intro}
    ${live.map((g) => groupHtml(g, asins, input.date)).join("")}
    ${problems > 0 ? WHAT_TO_DO : ""}
    ${
      past.length
        ? `<h2 style="margin:24px 0 4px;font-size:16px;color:${C.text}">Changes before tracking started</h2>
      <p style="margin:0 0 12px;font-size:13px;color:${C.muted}">From Keepa's history of the last 60 days — already happened, listed so you know where things stand.</p>
      ${past.map((g) => groupHtml(g, asins, input.date)).join("")}
      ${problems === 0 && past.some((g) => counts(g).split.length || counts(g).dropsInFamily.length) ? WHAT_TO_DO : ""}`
        : ""
    }
    <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:${C.muted}">
      Checked once a day. Family structure comes straight from Amazon's catalog; ratings counts come from Keepa and can lag Amazon by a day or two.
      "Ratings shown" is the count on the listing page — shared by the whole family while it's intact. "Own" is the number of written reviews on that one variation.
      ${input.appUrl ? `<br><a href="${esc(input.appUrl)}" style="color:${C.link}">Tracker status page</a>` : ""}
    </p>
  </div>
</body></html>`;

  return { subject, html, text: toText(subject, live, past, input), problems };
}

function toText(subject: string, live: Group[], past: Group[], input: DigestInput): string {
  const { asins } = input;
  const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const lines: string[] = [subject, ""];
  if (input.welcome) {
    lines.push(
      `Watching ${input.welcome.families} variation families (${input.welcome.variations} variations) across ${input.welcome.listed} listings. You'll only get an email when something changes.`,
      ""
    );
  }
  const section = (g: Group) => {
    lines.push(`== ${headline(g)}`, familyName(g, asins), g.familyAsin ? `Parent: ${amazonUrl(g.familyAsin)}` : "");
    for (const s of sentences(g, asins)) lines.push(`- ${strip(s)}`);
    if (g.changedAt) lines.push(`Keepa saw the change around ${fmtEt(g.changedAt)}`);
    for (const m of g.members.values()) {
      if (m.status === "in family" && !m.drop) continue;
      const d = m.drop;
      const ratings = d?.before !== undefined ? `${n(d.before)} -> ${n(d.after)} ratings` : `${n(asins.get(m.asin)?.rating_count)} ratings`;
      lines.push(`  * ${memberName(m.asin, asins)} (${m.asin}) — ${m.status}, ${ratings}`);
    }
    lines.push("");
  };
  live.forEach(section);
  if (past.length) {
    lines.push("Changes before tracking started (Keepa history, last 60 days):", "");
    past.forEach(section);
  }
  if (input.appUrl) lines.push(`Status page: ${input.appUrl}`);
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}
