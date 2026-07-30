// HTTPS mail relay for the Arpana ticket-server.
// Render's free tier blocks outbound SMTP, so the backend POSTs here and this
// function (running on Netlify, where SMTP egress works) sends via Gmail.
// Auth: shared secret in the X-Hook-Secret header.
import nodemailer from "nodemailer";

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = process.env.MAIL_HOOK_SECRET || "";
  if (!secret || req.headers.get("x-hook-secret") !== secret)
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  // Preferred: Brevo SMTP with the authenticated domain (SPF/DKIM on nrutyapuri.in)
  // — far better inbox placement than personal Gmail. Falls back to Gmail if unset.
  const brevoLogin = process.env.BREVO_LOGIN, brevoKey = process.env.BREVO_SMTP_KEY;
  const useBrevo = Boolean(brevoLogin && brevoKey);
  if (!useBrevo && (!user || !pass))
    return new Response(JSON.stringify({ error: "mailer not configured" }), { status: 503 });

  let body;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "bad json" }), { status: 400 }); }
  const messages = Array.isArray(body.messages) ? body.messages.slice(0, 5) : [];
  if (!messages.length) return new Response(JSON.stringify({ error: "no messages" }), { status: 400 });

  const transporter = useBrevo
    ? nodemailer.createTransport({ host: "smtp-relay.brevo.com", port: 587, auth: { user: brevoLogin, pass: brevoKey } })
    : nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  const from = useBrevo
    ? `"Nrutyapuri Dance Academy" <${process.env.MAIL_FROM || "tickets@nrutyapuri.in"}>`
    : `"Nrutyapuri Dance Academy" <${user}>`;
  const replyTo = "nrutyapuridanceacademy@gmail.com";
  const results = [];
  for (const m of messages) {
    try {
      // inline (cid) images — capped at 12 attachments / ~2MB total base64
      let total = 0;
      const attachments = (Array.isArray(m.attachments) ? m.attachments : []).slice(0, 12)
        .filter((a) => a && a.b64 && (total += a.b64.length) < 2_000_000)
        .map((a) => ({ filename: String(a.filename || "img"), cid: String(a.cid || ""), content: Buffer.from(String(a.b64), "base64"), contentType: String(a.type || "image/png") }));
      // plain-text alternative (reduces spam score for HTML-heavy mail)
      const text = String(m.html).replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 5000);
      await transporter.sendMail({ from, replyTo, to: String(m.to), subject: String(m.subject).slice(0, 200), html: String(m.html), text, attachments });
      results.push({ to: m.to, ok: true });
    } catch (e) {
      results.push({ to: m.to, ok: false, error: e.message });
    }
  }
  return new Response(JSON.stringify({ results }), { headers: { "content-type": "application/json" } });
};

export const config = { path: "/api/send-mail" };
