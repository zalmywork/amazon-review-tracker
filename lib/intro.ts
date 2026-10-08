import type { WelcomeInfo } from "./digest";

/** One-time email introducing the tracker to its recipient: what it does, and how to open the status page. */
export function buildIntro(opts: { siteUrl: string; password?: string; counts: WelcomeInfo; draft: boolean }) {
  const { siteUrl, counts } = opts;
  const password = opts.password ?? "ask Zalmy";
  const subject = `${opts.draft ? "[Draft] " : ""}Amazon review tracker`;
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const p = (s: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#111827">${s}</p>`;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:${font}">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    ${p("Hi Sara,")}
    ${p(`We set up a tool that watches our Amazon listings for reviews splitting off. It checks all ${counts.families} product families (${counts.variations} variations) every morning.`)}
    ${p("If a variation splits from its family, or its reviews stop being shared, you'll get an email that morning showing the product and its ratings before and after. No email means nothing changed.")}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;border:1px solid #e5e7eb;border-radius:8px;width:100%">
      <tr><td style="padding:14px 16px;font-size:14px;line-height:1.7;color:#111827">
        <div style="font-weight:600;margin-bottom:4px">Status page</div>
        <div><a href="${esc(siteUrl)}" style="color:#1d4ed8">${esc(siteUrl.replace(/^https?:\/\//, ""))}</a></div>
        <div>Password: <b>${esc(password)}</b> <span style="color:#6b7280">(any username)</span></div>
      </td></tr>
    </table>
    ${p("When an alert comes in: re-attach the variation in Variation Wizard, or ask Seller Support to re-merge the reviews.")}
    ${p("Zalmy")}
  </div>
</body></html>`;

  const text = [
    "Hi Sara,",
    "",
    `We set up a tool that watches our Amazon listings for reviews splitting off. It checks all ${counts.families} product families (${counts.variations} variations) every morning.`,
    "",
    "If a variation splits from its family, or its reviews stop being shared, you'll get an email that morning showing the product and its ratings before and after. No email means nothing changed.",
    "",
    `Status page: ${siteUrl}`,
    `Password: ${password} (any username)`,
    "",
    "When an alert comes in: re-attach the variation in Variation Wizard, or ask Seller Support to re-merge the reviews.",
    "",
    "Zalmy",
  ].join("\n");

  return { subject, html, text };
}
