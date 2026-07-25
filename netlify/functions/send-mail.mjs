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
  if (!user || !pass)
    return new Response(JSON.stringify({ error: "mailer not configured" }), { status: 503 });

  let body;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "bad json" }), { status: 400 }); }
  const messages = Array.isArray(body.messages) ? body.messages.slice(0, 5) : [];
  if (!messages.length) return new Response(JSON.stringify({ error: "no messages" }), { status: 400 });

  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  const from = `"Nrutyapuri Dance Academy" <${user}>`;
  const results = [];
  for (const m of messages) {
    try {
      await transporter.sendMail({ from, to: String(m.to), subject: String(m.subject).slice(0, 200), html: String(m.html) });
      results.push({ to: m.to, ok: true });
    } catch (e) {
      results.push({ to: m.to, ok: false, error: e.message });
    }
  }
  return new Response(JSON.stringify({ results }), { headers: { "content-type": "application/json" } });
};

export const config = { path: "/api/send-mail" };
