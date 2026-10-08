export const recipients = (list: string | undefined) =>
  (list ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export async function sendEmail(msg: {
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
  text: string;
}): Promise<string> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) throw new Error("Missing RESEND_API_KEY or MAIL_FROM env vars");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: msg.to,
      cc: msg.cc?.length ? msg.cc : undefined,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    }),
  });
  if (!res.ok) throw new Error(`Resend failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}
