/**
 * Arpana ticketing backend.
 *
 * Flow:
 *   POST /api/arpana/order   → create a Razorpay order (amount = qty × price)
 *   [ browser opens Razorpay Checkout, buyer pays via UPI ]
 *   POST /api/arpana/verify  → verify the payment signature SERVER-SIDE,
 *                              allocate ticket number(s), email buyer + academy
 *   GET  /api/arpana/status  → { total, sold, remaining, priceINR }
 *
 * Durability: the ledger is rebuilt from Razorpay's own record of paid orders
 * on startup, so it survives ephemeral hosting (Render free tier) restarts.
 * Never trust the browser for "payment success" — verification is signature-based.
 *
 * All secrets come from environment variables — nothing sensitive is in the repo.
 */
import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Razorpay from "razorpay";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = env.PORT || 8080;
const EVENT_NAME = env.EVENT_NAME || "Arpana";
const EVENT_DATE = env.EVENT_DATE || "";
const EVENT_VENUE = env.EVENT_VENUE || "";
const TOTAL = parseInt(env.TOTAL_TICKETS || "500", 10);
const PRICE = parseInt(env.PRICE_INR || "100", 10);
const PREFIX = env.TICKET_PREFIX || "ARPANA";
const ACADEMY_EMAIL = env.ACADEMY_EMAIL || env.GMAIL_USER || "";
const ALLOWED = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const LEDGER = path.join(__dirname, "tickets.json");
const pad = (n) => String(n).padStart(4, "0");

const razorpay =
  env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET
    ? new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET })
    : null;
if (!razorpay) console.warn("⚠  RAZORPAY_KEY_ID / _SECRET not set — ordering disabled until configured.");

// Render's free tier blocks outbound SMTP, so production email goes through an
// HTTPS relay (a Netlify function in front of Gmail). SMTP remains as a fallback
// for local development.
const MAIL_HOOK_URL = env.MAIL_HOOK_URL || "";
const MAIL_HOOK_SECRET = env.MAIL_HOOK_SECRET || "";
const smtpMailer =
  env.GMAIL_USER && env.GMAIL_APP_PASSWORD
    ? nodemailer.createTransport({ service: "gmail", auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD } })
    : null;
const mailer = env.BREVO_API_KEY || (MAIL_HOOK_URL && MAIL_HOOK_SECRET) || smtpMailer ? {} : null; // truthy flag: some mail path exists
if (!mailer) console.warn("⚠  No mail path configured (BREVO_API_KEY, MAIL_HOOK_URL/SECRET or GMAIL creds) — emails disabled.");

// Deliver a batch of {to, subject, html, attachments?} messages; returns [{to, ok, error?}]
// attachments: [{filename, cid, b64, type}] — embedded inline so ticket images
// render in every mail client without any external image loading.
//
// Transport preference:
//   1. Brevo HTTPS API — sends as tickets@nrutyapuri.in with the domain's
//      SPF/DKIM (best inbox placement; HTTPS works on Render's free tier)
//   2. Netlify mail-hook relay (Gmail)
//   3. Direct Gmail SMTP (local dev only)
const BREVO_KEY = env.BREVO_API_KEY || "";
const MAIL_FROM = env.MAIL_FROM || "tickets@nrutyapuri.in";
const REPLY_TO = env.REPLY_TO || "nrutyapuridanceacademy@gmail.com";
const htmlToText = (h) => String(h).replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 5000);
async function deliverMail(messages) {
  if (BREVO_KEY) {
    const out = [];
    for (const m of messages) {
      try {
        const payload = {
          sender: { name: "Nrutyapuri Dance Academy", email: MAIL_FROM },
          replyTo: { email: REPLY_TO },
          to: [{ email: m.to }],
          subject: m.subject,
          htmlContent: m.html,
          textContent: htmlToText(m.html),
        };
        if (Array.isArray(m.attachments) && m.attachments.length)
          payload.attachment = m.attachments.map((a) => ({ name: a.filename, content: a.b64 }));
        const res = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: { "api-key": BREVO_KEY, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`Brevo HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`);
        out.push({ to: m.to, ok: true });
      } catch (e) { out.push({ to: m.to, ok: false, error: e.message }); }
    }
    return out;
  }
  if (MAIL_HOOK_URL && MAIL_HOOK_SECRET) {
    const res = await fetch(MAIL_HOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hook-secret": MAIL_HOOK_SECRET },
      body: JSON.stringify({ messages }),
    });
    if (!res.ok) throw new Error(`mail hook HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).results || [];
  }
  if (!smtpMailer) throw new Error("no mail transport configured");
  const from = `"Nrutyapuri Dance Academy" <${env.GMAIL_USER}>`;
  const out = [];
  for (const m of messages) {
    try {
      const attachments = (m.attachments || []).map((a) => ({ filename: a.filename, cid: a.cid, content: Buffer.from(a.b64, "base64"), contentType: a.type }));
      await smtpMailer.sendMail({ from, to: m.to, subject: m.subject, html: m.html, attachments });
      out.push({ to: m.to, ok: true });
    }
    catch (e) { out.push({ to: m.to, ok: false, error: e.message }); }
  }
  return out;
}

// Fetch an image once and cache it as base64 (assets are static).
const imgCache = {};
async function fetchB64(url) {
  if (imgCache[url]) return imgCache[url];
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
  imgCache[url] = b64;
  return b64;
}

// ---------- ledger ----------
const readLedger = () => { try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); } catch { return { sold: 0, records: [] }; } };
const writeLedger = (l) => fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2));
let ledger = readLedger();
const remaining = () => TOTAL - ledger.sold;

// Rebuild the ledger from Razorpay's paid orders (source of truth, deterministic by time).
// Also returns the raw paid orders so the caller can reconcile un-emailed tickets.
async function rebuildFromRazorpay() {
  if (!razorpay) return [];
  try {
    const paid = [];
    let skip = 0, more = true;
    while (more && skip < 5000) {
      const res = await razorpay.orders.all({ count: 100, skip });
      const items = res.items || [];
      for (const o of items) {
        // EVENT_EPOCH (unix seconds): bookings made before launch (test purchases)
        // are excluded from the ledger, so the event went live with a clean 0/500.
        // Complimentary guest bookings (notes.comp="1") are unpaid orders used as
        // durable storage — they count as seats even though no payment exists.
        if (o.notes && o.notes.event === EVENT_NAME && o.created_at >= parseInt(env.EVENT_EPOCH || "0", 10) && (o.status === "paid" || o.notes.comp === "1")) paid.push(o);
      }
      more = items.length === 100;
      skip += 100;
    }
    paid.sort((a, b) => a.created_at - b.created_at);
    const l = { sold: 0, records: [] };
    for (const o of paid) {
      const qty = parseInt(o.notes.qty, 10) || 1;
      const nums = [];
      const comp = o.notes.comp === "1";
      for (let i = 0; i < qty; i++) { l.sold += 1; nums.push(`${PREFIX}-${pad(l.sold)}`); }
      l.records.push({ ticketNumbers: nums, name: o.notes.name || "", email: o.notes.email || "", phone: o.notes.phone || "", qty, amount: comp ? 0 : o.amount / 100, comp: comp || undefined, orderId: o.id, ts: o.created_at * 1000,
        checkedIn: parseInt(o.notes.checkedIn || "0", 10), passSent: o.notes.passSent === "1" || undefined });
    }
    ledger = l;
    writeLedger(ledger);
    console.log(`Ledger rebuilt from Razorpay — ${ledger.sold}/${TOTAL} sold.`);
    return paid;
  } catch (e) {
    console.warn("Rebuild skipped:", e.message);
    return [];
  }
}

// Durable "this order got its ticket email" marker, stored in the Razorpay order's
// own notes so it survives restarts of this (ephemeral-disk) server.
async function markEmailed(orderId, notes) {
  try {
    await razorpay.orders.edit(orderId, { notes: { ...notes, emailed: "1" } });
    console.log(`  ✓ marked emailed: ${orderId}`);
  } catch (e) {
    console.warn(`  could not mark emailed for ${orderId}:`, e.message);
  }
}

// Self-healing: any PAID order that never got its ticket email (e.g. the buyer paid
// in a UPI app and never returned to the browser, so /verify never fired) gets the
// email sent here. Runs at boot and every 10 minutes.
async function reconcileEmails() {
  if (!razorpay || !mailer) return;
  const paid = await rebuildFromRazorpay();
  for (const o of paid) {
    if (o.notes.emailed === "1") continue;
    const rec = ledger.records.find((r) => r.orderId === o.id);
    if (!rec || !rec.email) continue;
    console.log(`Reconcile: sending missed ticket email for ${o.id} → ${rec.email} (${rec.ticketNumbers.join(", ")})`);
    const ok = await sendTicketEmails(rec);
    if (ok) await markEmailed(o.id, o.notes);
  }
}

// ---------- emails ----------
async function sendTicketEmails({ name, email, phone, qty, amount, ticketNumbers, orderId, comp }) {
  if (!mailer) return;
  const nums = ticketNumbers.join(", ");
  // Entry-pass QR: one per BOOKING, scannable from any number of gate devices.
  // Only real Razorpay orders get a working QR (dry-run previews have no order).
  const showQr = /^order_/.test(String(orderId || ""));
  const qrApi = showQr ? "https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=" + encodeURIComponent(gateUrlFor(orderId)) : "";
  let qrB64 = "";
  if (showQr) { try { qrB64 = await fetchB64(qrApi); } catch (e) { console.warn("  QR fetch failed:", e.message); } }
  const qrBlock = showQr ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:2px 0 16px;background:#160f0a;border:1px solid #3a2c1a;border-left:5px solid #e9b04b;border-radius:12px">
        <tr><td align="center" style="padding:20px 20px 6px">
          <div style="background:#ffffff;border-radius:12px;padding:11px;display:inline-block">
            <img src="${qrApi}" width="196" height="196" alt="Entry pass QR code" style="display:block">
          </div>
        </td></tr>
        <tr><td align="center" style="padding:2px 20px 4px;font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:2.5px;color:#9a8a6e;text-transform:uppercase">Entry pass &middot; admits</td></tr>
        <tr><td align="center" style="padding:0 20px 16px;font-family:Georgia,serif;font-size:30px;font-weight:bold;color:#f3cf8e">${qty} ${qty > 1 ? "guests" : "guest"}</td></tr>
        <tr><td style="padding:0 22px 18px;font-family:Arial,Helvetica,sans-serif;font-size:12.5px;color:#bcae97;line-height:1.65;text-align:center">
          Show this QR at the entrance &mdash; one scan covers your whole group${qty > 1 ? ", and you may arrive in batches" : ""}. The QR is also attached to this email so you can save it offline.
        </td></tr>
      </table>` : "";
  const SITE = "https://nrutyapuri.in";
  const MAPS_URL =
    "https://www.google.com/maps/dir/?api=1&destination=" +
    encodeURIComponent(env.EVENT_MAPS_QUERY || "Ravindra Bharathi, Lakdikapul Rd, near State Assembly, Saifabad, Lakdikapul, Hyderabad, Telangana 500004");
  const ticketCards = ticketNumbers
    .map(
      (num, i) => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px 0;border-collapse:separate">
        <tr>
          <td style="background:#160f0a;border:1px solid #3a2c1a;border-left:5px solid #e9b04b;border-radius:12px;padding:18px 22px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-family:Arial,Helvetica,sans-serif">
                  <div style="font-size:10px;letter-spacing:2.5px;color:#9a8a6e;text-transform:uppercase;padding-bottom:6px">Admit One${qty > 1 ? ` — Ticket ${i + 1} of ${qty}` : ""}</div>
                  <div style="font-size:26px;font-weight:bold;color:#f3cf8e;letter-spacing:2px">${num}</div>
                </td>
                <td align="right" style="font-family:Arial,Helvetica,sans-serif;vertical-align:middle">
                  <div style="display:inline-block;background:#241708;border:1px solid #4a3310;border-radius:8px;color:#e9b04b;font-size:11px;letter-spacing:1.5px;padding:8px 12px;text-transform:uppercase">${EVENT_NAME}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>`
    )
    .join("");
  const buyerHtml = `
  <div style="background:#0a0605;padding:28px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;border-collapse:separate">
      <!-- header -->
      <tr>
        <td style="background:linear-gradient(120deg,#e9b04b,#ff5e2b);border-radius:16px 16px 0 0;padding:26px 30px;font-family:Georgia,'Times New Roman',serif">
          <div style="font-size:24px;font-weight:bold;color:#160a05">Nrutyapuri Dance Academy</div>
          <div style="font-size:12px;letter-spacing:3px;color:#3d2208;text-transform:uppercase;padding-top:4px">Classical Odissi · Hyderabad</div>
        </td>
      </tr>
      <!-- body -->
      <tr>
        <td style="background:#0f0a08;border:1px solid #2e2314;border-top:0;padding:30px;font-family:Arial,Helvetica,sans-serif;color:#f4e9d6">
          <div style="text-align:center;padding-bottom:22px">
            <div style="display:inline-block;width:54px;height:54px;line-height:54px;border-radius:50%;background:#1d2b17;border:1px solid #3f6b33;color:#8fd67c;font-size:26px">&#10003;</div>
            <div style="font-size:20px;font-weight:bold;padding-top:12px">Booking Confirmed</div>
            <div style="font-size:13px;color:#bcae97;padding-top:4px">${comp
              ? `Namaste ${name}, you are our honoured guest — your ticket${qty > 1 ? "s are" : " is"} confirmed with the compliments of the academy.`
              : `Namaste ${name}, your payment of <b style="color:#f3cf8e">&#8377;${amount}</b> was successful.`}</div>
          </div>

          <div style="font-size:11px;letter-spacing:2.5px;color:#9a8a6e;text-transform:uppercase;padding:6px 0 12px">Your ticket${qty > 1 ? "s" : ""}</div>
          ${ticketCards}
          ${qrBlock}

          <!-- event details -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;background:#120c09;border:1px solid #2e2314;border-radius:12px">
            <tr><td style="padding:18px 22px 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2.5px;color:#9a8a6e;text-transform:uppercase">Event details</td></tr>
            <tr><td style="padding:0 22px 18px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;font-size:14px">
                <tr>
                  <td style="padding:7px 0;color:#bcae97">Event</td>
                  <td style="padding:7px 0;color:#f4e9d6;text-align:right;font-weight:bold">${EVENT_NAME} — An Offering in Dance</td>
                </tr>
                <tr>
                  <td style="padding:7px 0;color:#bcae97;border-top:1px solid #241a10">Date &amp; time</td>
                  <td style="padding:7px 0;color:#f4e9d6;text-align:right;border-top:1px solid #241a10">${EVENT_DATE || "To be announced"}</td>
                </tr>
                <tr>
                  <td style="padding:7px 0;color:#bcae97;border-top:1px solid #241a10">Venue</td>
                  <td style="padding:7px 0;text-align:right;border-top:1px solid #241a10"><a href="${MAPS_URL}" style="color:#f4e9d6;font-weight:bold;text-decoration:underline">${EVENT_VENUE || "To be announced"}</a> <a href="${MAPS_URL}" style="color:#e9b04b;text-decoration:none;font-size:12px">&#128205; Map</a></td>
                </tr>
                <tr>
                  <td style="padding:7px 0;color:#bcae97;border-top:1px solid #241a10">Tickets</td>
                  <td style="padding:7px 0;color:#f4e9d6;text-align:right;border-top:1px solid #241a10">${comp ? `${qty} &times; Guest invitation` : `${qty} &times; &#8377;${PRICE}`}</td>
                </tr>
                <tr>
                  <td style="padding:7px 0;color:#bcae97;border-top:1px solid #241a10">${comp ? "Admission" : "Amount paid"}</td>
                  <td style="padding:7px 0;color:#8fd67c;text-align:right;font-weight:bold;border-top:1px solid #241a10">${comp ? "Complimentary" : `&#8377;${amount}`}</td>
                </tr>
                <tr>
                  <td style="padding:7px 0;color:#bcae97;border-top:1px solid #241a10">Order ref</td>
                  <td style="padding:7px 0;color:#7d715e;text-align:right;font-size:12px;border-top:1px solid #241a10">${orderId}</td>
                </tr>
              </table>
            </td></tr>
          </table>

          <div style="margin-top:22px;background:#1a1206;border:1px solid #3a2c1a;border-radius:10px;padding:14px 18px;font-size:13px;color:#d8c9a8;line-height:1.6">
            &#128278; <b>At the venue:</b> ${showQr ? "show the QR above at the entrance — our team will scan it and admit your group." : "show this email or quote your ticket number at entry."}
          </div>
        </td>
      </tr>
      <!-- footer -->
      <tr>
        <td style="background:#0b0705;border:1px solid #2e2314;border-top:0;border-radius:0 0 16px 16px;padding:20px 30px;font-family:Arial,Helvetica,sans-serif;text-align:center">
          <div style="font-size:13px;color:#bcae97">Questions? We're happy to help.</div>
          <div style="font-size:13px;padding-top:6px">
            <a href="mailto:${env.GMAIL_USER}" style="color:#e9b04b;text-decoration:none">${env.GMAIL_USER}</a>
            <span style="color:#5c5344">&nbsp;·&nbsp;</span>
            <span style="color:#d8c9a8">+91 87540 00520</span>
          </div>
          <div style="font-size:12px;color:#5c5344;padding-top:12px">Nrutyapuri Dance Academy · Crayons Creative School, Alkapur, Hyderabad<br>
            <a href="https://nrutyapuri.in" style="color:#9a8a6e;text-decoration:none">nrutyapuri.in</a>
          </div>
        </td>
      </tr>
    </table>
  </div>`;
  const academyHtml = `
    <div style="font-family:Arial,sans-serif">
      <h2>${comp ? `${EVENT_NAME} guest tickets issued` : `New ${EVENT_NAME} booking`}</h2>
      <p><b>${name}</b> ${comp ? `was issued <b>${qty}</b> complimentary guest ticket(s)` : `booked <b>${qty}</b> ticket(s) — ₹${amount}`}</p>
      <ul>
        <li>Tickets: ${nums}</li>
        <li>Email: ${email}</li>
        <li>Phone: ${phone}</li>
        <li>Order: ${orderId}</li>
      </ul>
      <p>Sold so far: ${ledger.sold}/${TOTAL} (${remaining()} left)</p>
    </div>`;
  const messages = [
    { to: email, subject: `Your ${EVENT_NAME} ticket${qty > 1 ? "s" : ""} — ${nums}`, html: buyerHtml,
      attachments: qrB64 ? [{ filename: `arpana-entry-pass-${orderId}.png`, b64: qrB64, type: "image/png" }] : [] },
  ];
  if (ACADEMY_EMAIL)
    messages.push({ to: ACADEMY_EMAIL, subject: comp ? `${EVENT_NAME} guest tickets — ${name} × ${qty}` : `New ${EVENT_NAME} booking — ${name} × ${qty}`, html: academyHtml });
  let buyerOk = false;
  try {
    const results = await deliverMail(messages);
    results.forEach((r) => {
      if (r.ok) {
        console.log(`  ✉ sent <${r.to}> [${nums}]`);
        if (r.to === email) buyerOk = true;
      } else {
        console.error(`  ✗ email FAILED <${r.to}>:`, r.error);
      }
    });
  } catch (e) {
    console.error("  ✗ mail delivery error:", e.message);
  }
  return buyerOk;
}

// ---------- app ----------
const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED.length ? ALLOWED : true }));

app.get("/", (_req, res) => res.json({ ok: true, event: EVENT_NAME, sold: ledger.sold, total: TOTAL }));

app.get("/api/arpana/status", (_req, res) =>
  res.json({ total: TOTAL, sold: ledger.sold, remaining: remaining(), priceINR: PRICE })
);

// Private: full booking list for the academy (protected by ADMIN_TOKEN env).
app.get("/api/arpana/bookings", (req, res) => {
  const token = req.get("x-admin-token") || String(req.query.token || "");
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN)
    return res.status(401).json({ error: "unauthorized" });
  res.json({
    event: EVENT_NAME,
    total: TOTAL,
    sold: ledger.sold,
    remaining: remaining(),
    priceINR: PRICE,
    records: ledger.records,
  });
});

app.post("/api/arpana/order", async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: "Payments not configured yet." });
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim();
  const phone = String(req.body.phone || "").trim();
  const qty = Math.max(1, Math.min(10, parseInt(req.body.qty, 10) || 1));
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || phone.replace(/\D/g, "").length < 10)
    return res.status(400).json({ error: "Please provide a valid name, email and phone." });
  if (remaining() < qty) return res.status(409).json({ error: `Only ${remaining()} ticket(s) left.` });
  try {
    const order = await razorpay.orders.create({
      amount: qty * PRICE * 100, // paise
      currency: "INR",
      receipt: `arpana_${Date.now()}`,
      notes: { event: EVENT_NAME, name, email, phone, qty: String(qty) },
    });
    res.json({ orderId: order.id, amount: order.amount, keyId: env.RAZORPAY_KEY_ID });
  } catch (e) {
    res.status(500).json({ error: "Could not create order. " + (e.error?.description || e.message) });
  }
});

app.post("/api/arpana/verify", async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: "Payments not configured." });
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res.status(400).json({ error: "Missing payment fields." });

  // 1) verify signature (server-side, authoritative)
  const expected = crypto
    .createHmac("sha256", env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");
  if (expected !== razorpay_signature) return res.status(400).json({ error: "Payment signature verification failed." });

  // 2) idempotency — already processed?
  const existing = ledger.records.find((r) => r.orderId === razorpay_order_id);
  if (existing) return res.json({ ticketNumbers: existing.ticketNumbers });

  try {
    // 3) authoritative details from the order (qty is locked to what was paid)
    const order = await razorpay.orders.fetch(razorpay_order_id);
    if (order.status !== "paid") return res.status(400).json({ error: "Order not paid." });
    const n = order.notes || {};
    const qty = parseInt(n.qty, 10) || 1;

    // 4) allocate ticket numbers
    const nums = [];
    for (let i = 0; i < qty; i++) { ledger.sold += 1; nums.push(`${PREFIX}-${pad(ledger.sold)}`); }
    const rec = { ticketNumbers: nums, name: n.name || "", email: n.email || "", phone: n.phone || "", qty, amount: order.amount / 100, orderId: order.id, paymentId: razorpay_payment_id, ts: Date.now() };
    ledger.records.push(rec);
    writeLedger(ledger);

    // 5) email (don't block the response on mail delivery); mark the order as
    //    emailed in Razorpay notes so the reconciler never re-sends it
    sendTicketEmails(rec)
      .then((ok) => { if (ok) return markEmailed(order.id, { ...n }); })
      .catch((e) => console.warn("mail error:", e.message));

    res.json({ ticketNumbers: nums });
  } catch (e) {
    res.status(500).json({ error: "Verification error. " + e.message });
  }
});

// Complimentary guest tickets (participants' parents etc.) — admin only.
// Same ticket email as a paid booking, but no payment. Stored durably as an
// UNPAID Razorpay order flagged notes.comp="1" (rebuildFromRazorpay counts it),
// so guest bookings survive restarts and occupy real seats out of the 500.
// GET-triggerable so it can be fired from a browser URL:
//   /api/arpana/comp?name=...&email=...&qty=2&token=ADMIN_TOKEN   (+&test=1 for a dry run)
app.all("/api/arpana/comp", async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
  const src = req.method === "POST" ? req.body || {} : req.query;
  const name = String(src.name || "").trim();
  const email = String(src.email || "").trim();
  const phone = String(src.phone || "").trim();
  const qty = Math.max(1, Math.min(20, parseInt(src.qty, 10) || 1));
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return res.status(400).json({ error: "Provide a valid name and email." });

  // Dry run: sends the real email with placeholder ticket numbers; touches nothing.
  if (String(src.test || "") === "1") {
    const nums = Array.from({ length: qty }, (_, i) => `${PREFIX}-TEST${i + 1}`);
    const ok = await sendTicketEmails({ name, email, phone, qty, amount: 0, ticketNumbers: nums, orderId: "GUEST-TEST", comp: true });
    return res.json({ ok, test: true, ticketNumbers: nums });
  }

  if (!razorpay) return res.status(503).json({ error: "Razorpay not configured." });
  if (remaining() < qty) return res.status(409).json({ error: `Only ${remaining()} ticket(s) left.` });
  // Idempotency guard: refuse an exact duplicate (same email + qty) unless forced.
  const dup = ledger.records.find((r) => r.comp && r.email === email && r.qty === qty);
  if (dup && String(src.force || "") !== "1")
    return res.status(409).json({ error: `Guest tickets already issued to ${email} (${dup.ticketNumbers.join(", ")}). Add &force=1 to issue again.`, ticketNumbers: dup.ticketNumbers });
  try {
    const order = await razorpay.orders.create({
      amount: 100, // ₹1 placeholder — never paid; the order exists only as durable storage
      currency: "INR",
      receipt: `comp_${Date.now()}`,
      notes: { event: EVENT_NAME, name, email, phone, qty: String(qty), comp: "1" },
    });
    const nums = [];
    for (let i = 0; i < qty; i++) { ledger.sold += 1; nums.push(`${PREFIX}-${pad(ledger.sold)}`); }
    const rec = { ticketNumbers: nums, name, email, phone, qty, amount: 0, comp: true, orderId: order.id, ts: Date.now() };
    ledger.records.push(rec);
    writeLedger(ledger);
    const ok = await sendTicketEmails(rec);
    if (ok) await markEmailed(order.id, order.notes || {});
    res.json({ ok: true, emailed: ok, ticketNumbers: nums, sold: ledger.sold, remaining: remaining() });
  } catch (e) {
    res.status(500).json({ error: "Could not issue guest tickets. " + (e.error?.description || e.message) });
  }
});


// ---------- entry passes (booking QR + gate check-in) ----------
// One QR per BOOKING. QR encodes a signed gate URL; the gate page lets staff
// check in any number of the booking's guests, persisted in the Razorpay
// order's notes (survives restarts). TEST passes (o=TESTn) live in memory only.
const SELF_URL = env.SELF_URL || "https://nrutyapuri-ticket-server.onrender.com";
const passSig = (id) => crypto.createHmac("sha256", env.RAZORPAY_KEY_SECRET || "dev").update(`arpana-pass:${id}`).digest("hex").slice(0, 16);
const gateUrlFor = (id) => `${SELF_URL}/gate?o=${encodeURIComponent(id)}&s=${passSig(id)}`;
const testCheckins = {}; // in-memory check-in counts for TESTn passes
const isAdmin = (req) => env.ADMIN_TOKEN && (req.get("x-admin-token") || String(req.query.token || "")) === env.ADMIN_TOKEN;

async function passInfo(orderId) {
  const t = /^TEST(\d{1,2})$/.exec(orderId);
  if (t) {
    const qty = Math.max(1, parseInt(t[1], 10));
    return { name: "Test Booking", phone: "", qty, checkedIn: testCheckins[orderId] || 0,
      ticketNumbers: Array.from({ length: qty }, (_, i) => `TEST-${pad(i + 1)}`), test: true };
  }
  const o = await razorpay.orders.fetch(orderId);
  if (!o.notes || o.notes.event !== EVENT_NAME) return null;
  // complimentary guest bookings are stored as UNPAID orders (notes.comp="1")
  if (o.status !== "paid" && o.notes.comp !== "1") return null;
  if (o.created_at < parseInt(env.EVENT_EPOCH || "0", 10)) return null; // pre-launch test purchase
  const rec = ledger.records.find((r) => r.orderId === orderId);
  return { name: o.notes.name || "", phone: o.notes.phone || "", qty: parseInt(o.notes.qty, 10) || 1,
    checkedIn: parseInt(o.notes.checkedIn || "0", 10),
    ticketNumbers: rec ? rec.ticketNumbers : [], notes: o.notes, test: false };
}

async function sendEntryPass({ orderId, name, email, qty, ticketNumbers }) {
  const url = gateUrlFor(orderId);
  const qrApi = "https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=" + encodeURIComponent(url);
  let qrB64 = "";
  try { qrB64 = await fetchB64(qrApi); } catch (e) { console.warn("  QR fetch failed:", e.message); }
  const nums = (ticketNumbers || []).join(", ");
  const html = `
  <div style="background:#0a0605;padding:28px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;border-collapse:separate">
      <tr><td style="background:linear-gradient(120deg,#e9b04b,#ff5e2b);border-radius:16px 16px 0 0;padding:24px 30px;font-family:Georgia,'Times New Roman',serif">
        <div style="font-size:23px;font-weight:bold;color:#160a05">Nrutyapuri Dance Academy</div>
        <div style="font-size:12px;letter-spacing:3px;color:#3d2208;text-transform:uppercase;padding-top:4px">Arpana &middot; Entry Pass</div>
      </td></tr>
      <tr><td style="background:#0f0a08;border:1px solid #2e2314;border-top:0;padding:28px 30px;font-family:Arial,Helvetica,sans-serif;color:#f4e9d6">
        <div style="font-size:13px;color:#bcae97">Namaste ${name},</div>
        <div style="font-size:19px;font-weight:bold;padding:6px 0 18px">Your entry pass for ${EVENT_NAME} is ready</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#160f0a;border:1px solid #3a2c1a;border-left:5px solid #e9b04b;border-radius:12px">
          <tr><td align="center" style="padding:22px 20px 8px">
            <div style="background:#ffffff;border-radius:12px;padding:12px;display:inline-block">
              <img src="${qrApi}" width="200" height="200" alt="Entry pass QR" style="display:block">
            </div>
          </td></tr>
          <tr><td align="center" style="padding:6px 20px 4px;font-size:11px;letter-spacing:2.5px;color:#9a8a6e;text-transform:uppercase">Admits</td></tr>
          <tr><td align="center" style="padding:0 20px 6px;font-family:Georgia,serif;font-size:34px;font-weight:bold;color:#f3cf8e">${qty} ${qty > 1 ? "guests" : "guest"}</td></tr>
          <tr><td align="center" style="padding:0 20px 20px;font-size:12px;color:#bcae97">Ticket${qty > 1 ? "s" : ""}: ${nums}</td></tr>
        </table>
        <div style="font-size:12.5px;color:#bcae97;line-height:1.7;padding-top:16px">
          Show this QR at the entrance &mdash; one scan covers your whole group, and you may arrive in batches.
          The pass is also attached as an image for easy saving. Please don&rsquo;t share it publicly: entries are limited to ${qty}.
        </div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;background:#120c09;border:1px solid #2e2314;border-radius:12px;font-size:13px">
          <tr><td style="padding:12px 18px;color:#bcae97">Date</td><td style="padding:12px 18px;text-align:right;font-weight:bold;color:#f4e9d6">${EVENT_DATE || "To be announced"}</td></tr>
          <tr><td style="padding:0 18px 12px;color:#bcae97">Venue</td><td style="padding:0 18px 12px;text-align:right"><a href="${MAPS_URL_G}" style="color:#e9b04b;font-weight:bold">${EVENT_VENUE || "To be announced"} &#128205;</a></td></tr>
        </table>
      </td></tr>
      <tr><td style="background:#0c0806;border:1px solid #2e2314;border-top:0;border-radius:0 0 16px 16px;padding:16px 30px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#7d715f;text-align:center">
        Nrutyapuri Dance Academy &middot; Hyderabad &middot; <a href="mailto:${REPLY_TO}" style="color:#9a8a6e">${REPLY_TO}</a>
      </td></tr>
    </table>
  </div>`;
  const attachments = qrB64 ? [{ filename: `arpana-entry-pass-${orderId}.png`, b64: qrB64, type: "image/png" }] : [];
  const results = await deliverMail([{ to: email, subject: `Your ${EVENT_NAME} Entry Pass — admits ${qty}`, html, attachments }]);
  const ok = results[0] && results[0].ok;
  console.log(ok ? `  ✉ entry pass sent <${email}> [${orderId}]` : `  ✗ entry pass FAILED <${email}>: ${results[0] && results[0].error}`);
  return ok;
}
const MAPS_URL_G = "https://www.google.com/maps/dir/?api=1&destination=" +
  encodeURIComponent(env.EVENT_MAPS_QUERY || "Ravindra Bharathi, Lakdikapul Rd, near State Assembly, Saifabad, Lakdikapul, Hyderabad, Telangana 500004");

// Booking status for the gate page
app.get("/api/arpana/pass", async (req, res) => {
  try {
    const o = String(req.query.o || ""), s = String(req.query.s || "");
    if (!o || s !== passSig(o)) return res.json({ valid: false });
    const info = await passInfo(o);
    if (!info) return res.json({ valid: false });
    res.json({ valid: true, orderId: o, name: info.name, qty: info.qty, checkedIn: info.checkedIn,
      remaining: info.qty - info.checkedIn, ticketNumbers: info.ticketNumbers, test: info.test });
  } catch (e) { res.json({ valid: false }); }
});

// Per-booking mutex: several gate devices may scan the SAME pass at the same
// moment, and check-in is a read-modify-write on the order notes — serialise it
// per booking so simultaneous scans can never admit more people than allowed.
const passLocks = {};
function withPassLock(orderId, fn) {
  const prev = passLocks[orderId] || Promise.resolve();
  const next = prev.then(fn, fn);
  passLocks[orderId] = next.catch(() => {});
  return next;
}

// Gate staff check-in (admin token required)
app.post("/api/arpana/checkin", async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    const o = String(req.body.o || ""), s = String(req.body.s || "");
    // negative count = UNDO a mis-tap at the gate (e.g. staff entered 3 instead of 2)
    const count = parseInt(req.body.count, 10) || 1;
    if (!o || s !== passSig(o)) return res.status(400).json({ error: "invalid pass" });
    const out = await withPassLock(o, async () => {
      const info = await passInfo(o);
      if (!info) return { status: 400, body: { error: "invalid pass" } };
      const remaining = info.qty - info.checkedIn;
      if (count > remaining)
        return { status: 409, body: { error: remaining === 0 ? "This pass is fully used — everyone on it has already entered." : `Only ${remaining} entr${remaining === 1 ? "y" : "ies"} remaining on this pass.`, checkedIn: info.checkedIn, remaining } };
      if (info.checkedIn + count < 0)
        return { status: 409, body: { error: `Only ${info.checkedIn} checked in — nothing more to undo.`, checkedIn: info.checkedIn, remaining } };
      const newCount = info.checkedIn + count;
      if (info.test) testCheckins[o] = newCount;
      else await razorpay.orders.edit(o, { notes: { ...info.notes, checkedIn: String(newCount), lastCheckin: new Date().toISOString() } });
      console.log(`Gate: checked in ${count} on ${o} (${newCount}/${info.qty})`);
      return { status: 200, body: { ok: true, checkedIn: newCount, remaining: info.qty - newCount } };
    });
    res.status(out.status).json(out.body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Look up a booking's gate link WITHOUT emailing it (admin).
// Used for testing, and at the gate for a guest who lost their ticket email.
// Accepts a Razorpay order id or a TESTn id.
app.get("/api/arpana/pass-url", async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
  const o = String(req.query.o || "").trim();
  if (!o) return res.status(400).json({ error: "?o=<orderId> required" });
  try {
    const info = await passInfo(o);
    if (!info) return res.status(404).json({ error: "no valid booking for that id" });
    res.json({ orderId: o, gateUrl: gateUrlFor(o), name: info.name, qty: info.qty,
      checkedIn: info.checkedIn, remaining: info.qty - info.checkedIn, ticketNumbers: info.ticketNumbers, test: info.test });
  } catch (e) { res.status(404).json({ error: "no booking found for that id" }); }
});

// Gate fallback: find a booking by name / email / phone / ticket number when the
// guest can't produce their QR (lost email, flat battery, spam folder).
// Returns LIVE check-in state so staff can admit straight from the result.
app.get("/api/arpana/find", async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
  const q = String(req.query.q || "").trim().toLowerCase();
  if (q.length < 2) return res.json({ matches: [], error: "type at least 2 characters" });
  const digits = q.replace(/\D/g, "");
  const hits = ledger.records.filter((r) => {
    if ((r.name || "").toLowerCase().includes(q)) return true;
    if ((r.email || "").toLowerCase().includes(q)) return true;
    if (digits.length >= 4 && (r.phone || "").replace(/\D/g, "").includes(digits)) return true;
    return (r.ticketNumbers || []).some((t) => t.toLowerCase().includes(q));
  });
  const capped = hits.slice(0, 12);
  const matches = await Promise.all(capped.map(async (r) => {
    let live = null;
    try { live = await passInfo(r.orderId); } catch (e) { /* fall back to ledger */ }
    const checkedIn = live ? live.checkedIn : (r.checkedIn || 0);
    return { orderId: r.orderId, name: r.name, email: r.email, phone: r.phone,
      qty: r.qty, checkedIn, remaining: r.qty - checkedIn, comp: !!r.comp,
      ticketNumbers: r.ticketNumbers, gateUrl: gateUrlFor(r.orderId) };
  }));
  res.json({ matches, total: hits.length, truncated: hits.length > capped.length });
});

// Send a TEST entry pass (admin; GET so it can be triggered from a browser)
app.all("/api/arpana/send-test-pass", async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
  const to = String(req.query.to || req.body?.to || "").trim();
  const qty = Math.max(1, Math.min(20, parseInt(req.query.qty || req.body?.qty, 10) || 3));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: "valid ?to= email required" });
  const orderId = `TEST${qty}`;
  const ok = await sendEntryPass({ orderId, name: "Test Booking", email: to, qty,
    ticketNumbers: Array.from({ length: qty }, (_, i) => `TEST-${pad(i + 1)}`) });
  res.json({ ok, gateUrl: gateUrlFor(orderId) });
});

// Send the real entry pass for one booking (admin; used in the step-3 rollout)
app.post("/api/arpana/send-pass", async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
  const orderId = String(req.body.orderId || "").trim();
  const rec = ledger.records.find((r) => r.orderId === orderId);
  if (!rec || !rec.email) return res.status(404).json({ error: "booking not found" });
  const ok = await sendEntryPass(rec);
  res.json({ ok, orderId, email: rec.email });
});

// Bulk send entry passes to every existing booking (paid + complimentary) made
// BEFORE the QR was added to the ticket email. Runs as a background job so the
// HTTP request can't time out; poll GET /api/arpana/pass-job for progress.
// Durable marker notes.passSent="1" — safe to re-run, never double-sends.
const passJob = { running: false, total: 0, sent: 0, skipped: 0, failed: 0, failures: [], startedAt: null, finishedAt: null };
async function runPassJob({ dry, only }) {
  passJob.running = true; passJob.sent = 0; passJob.skipped = 0; passJob.failed = 0; passJob.failures = [];
  passJob.startedAt = new Date().toISOString(); passJob.finishedAt = null;
  try {
    const orders = await rebuildFromRazorpay(); // fresh ledger + fresh notes
    const targets = [];
    for (const o of orders) {
      const rec = ledger.records.find((r) => r.orderId === o.id);
      if (!rec || !rec.email) continue;
      if (only && rec.email.toLowerCase() !== only.toLowerCase()) continue;
      if (o.notes.passSent === "1") { passJob.skipped++; continue; }
      targets.push({ rec, notes: o.notes });
    }
    passJob.total = targets.length;
    console.log(`Pass job: ${targets.length} to send, ${passJob.skipped} already sent${dry ? " (DRY RUN)" : ""}`);
    for (const t of targets) {
      if (dry) { passJob.sent++; continue; }
      let ok = false;
      try { ok = await sendEntryPass(t.rec); } catch (e) { console.warn("  pass send error:", e.message); }
      if (ok) {
        passJob.sent++;
        try { await razorpay.orders.edit(t.rec.orderId, { notes: { ...t.notes, passSent: "1" } }); }
        catch (e) { console.warn("  could not mark passSent:", e.message); }
      } else {
        passJob.failed++;
        passJob.failures.push(t.rec.email);
      }
      await new Promise((r) => setTimeout(r, 1500)); // pace sends for deliverability
    }
  } catch (e) {
    console.error("Pass job error:", e.message);
    passJob.failures.push("JOB ERROR: " + e.message);
  }
  passJob.running = false; passJob.finishedAt = new Date().toISOString();
  console.log(`Pass job done — sent ${passJob.sent}, failed ${passJob.failed}, skipped ${passJob.skipped}`);
}

app.all("/api/arpana/send-all-passes", async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
  if (passJob.running) return res.status(409).json({ error: "a pass job is already running", job: passJob });
  const dry = String(req.query.dry || req.body?.dry || "") === "1";
  const only = String(req.query.only || req.body?.only || "").trim();
  runPassJob({ dry, only }); // fire and forget; poll /api/arpana/pass-job
  res.json({ started: true, dry, only: only || null, poll: "/api/arpana/pass-job" });
});

app.get("/api/arpana/pass-job", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
  res.json(passJob);
});

// The gate page itself (served from this server so it needs no other hosting)
const GATE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="robots" content="noindex">
<title>Arpana Gate</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0605;color:#f4e9d6;font-family:'Outfit','Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:26px 16px}
.brand{font-family:Georgia,serif;font-size:1.15rem;color:#f4e9d6;margin-bottom:18px}.brand em{color:#e9b04b}
.card{width:100%;max-width:400px;border-radius:18px;overflow:hidden;border:1px solid #3a2c1a;background:#120c09}
.status{padding:20px;text-align:center;font-size:1.25rem;font-weight:700;letter-spacing:.04em}
.ok{background:#173d1c;color:#8fd67c}.warn{background:#4a3310;color:#f3cf8e}.bad{background:#4a1410;color:#ff9c8a}
.body{padding:20px 22px}
.row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #241a10;font-size:.95rem}
.row b{color:#f3cf8e}.muted{color:#9a8a6e}
.bignum{display:flex;justify-content:space-around;text-align:center;padding:16px 0 6px}
.bignum div span{display:block;font-size:2rem;font-family:Georgia,serif;color:#f3cf8e;font-weight:700}
.bignum div small{color:#9a8a6e;text-transform:uppercase;letter-spacing:.12em;font-size:.65rem}
.counter{display:flex;align-items:center;justify-content:center;gap:18px;padding:16px 0 6px}
.counter button{width:52px;height:52px;border-radius:50%;border:1px solid #e9b04b;background:none;color:#e9b04b;font-size:1.6rem;cursor:pointer}
.counter span{font-size:2rem;font-family:Georgia,serif;min-width:56px;text-align:center}
.go{display:block;width:100%;margin-top:14px;padding:15px;border:none;border-radius:40px;background:linear-gradient(100deg,#f3cf8e,#ff5e2b);color:#1a0d05;font-weight:700;font-size:1rem;cursor:pointer;letter-spacing:.05em}
.link{background:none;border:1px solid #4a3310;color:#9a8a6e;border-radius:40px;padding:11px;width:100%;margin-top:12px;cursor:pointer;font-size:.85rem}
.msg{text-align:center;color:#9a8a6e;font-size:.85rem;padding-top:12px;min-height:1.2em}
.findlink{display:block;text-align:center;color:#9a8a6e;font-size:.85rem;text-decoration:none;margin-top:18px;padding:12px}
.findlink:active{color:#e9b04b}
</style></head><body>
<div class="brand">Nrutyapuri <em>Dance Academy</em> &middot; Gate</div>
<div class="card"><div id="status" class="status warn">Checking pass&hellip;</div><div class="body" id="body"></div></div>
<a class="findlink" href="/gate/find">No QR? Find the booking by name or phone &rarr;</a>
<script>
var q = new URLSearchParams(location.search);
var O = q.get('o') || '', S = q.get('s') || '';
var st = document.getElementById('status'), bd = document.getElementById('body');
var state = null, n = 1;
function esc(x){ return String(x==null?'':x).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function token(){ return localStorage.getItem('gateToken') || ''; }
function render(){
  if (!state || !state.valid){ st.className='status bad'; st.textContent='INVALID PASS'; bd.innerHTML='<div class="msg">This QR is not a valid ' + 'Arpana entry pass.</div>'; return; }
  var full = state.remaining <= 0;
  st.className = 'status ' + (full ? 'warn' : 'ok');
  st.textContent = full ? 'FULLY USED' : 'VALID PASS';
  var h = '';
  h += '<div class="row"><span class="muted">Guest</span><b>' + esc(state.name) + '</b></div>';
  h += '<div class="row"><span class="muted">Booking</span><b>' + esc(state.orderId) + (state.test ? ' (TEST)' : '') + '</b></div>';
  h += '<div class="row"><span class="muted">Tickets</span><b style="text-align:right">' + esc((state.ticketNumbers||[]).join(', ')) + '</b></div>';
  h += '<div class="bignum"><div><span>' + state.qty + '</span><small>Admits</small></div>';
  h += '<div><span>' + state.checkedIn + '</span><small>Checked in</small></div>';
  h += '<div><span>' + state.remaining + '</span><small>Remaining</small></div></div>';
  if (!full){
    if (token()){
      if (n > state.remaining) n = state.remaining;
      h += '<div class="counter"><button onclick="bump(-1)">&minus;</button><span id="cnt">' + n + '</span><button onclick="bump(1)">+</button></div>';
      h += '<button class="go" onclick="checkin()">&#10003; Check in ' + n + '</button>';
    } else {
      h += '<button class="link" onclick="staff()">Gate staff? Tap to check in</button>';
    }
  }
  h += '<div class="msg" id="msg"></div>';
  bd.innerHTML = h;
}
function bump(d){ n = Math.min(Math.max(1, n + d), state.remaining); render(); }
function staff(){ var t = prompt('Gate passcode:'); if (t){ localStorage.setItem('gateToken', t.trim()); render(); } }
function load(){
  fetch('/api/arpana/pass?o=' + encodeURIComponent(O) + '&s=' + encodeURIComponent(S))
    .then(function(r){ return r.json(); }).then(function(j){ state = j; n = 1; render(); })
    .catch(function(){ st.className='status bad'; st.textContent='CONNECTION ERROR'; bd.innerHTML='<div class="msg">Please retry.</div>'; });
}
function checkin(){
  var m = document.getElementById('msg'); m.textContent = 'Checking in…';
  fetch('/api/arpana/checkin', { method:'POST', headers:{'Content-Type':'application/json','X-Admin-Token':token()},
    body: JSON.stringify({ o:O, s:S, count:n }) })
  .then(function(r){ return r.json().then(function(j){ return { s:r.status, j:j }; }); })
  .then(function(x){
    if (x.s === 401){ localStorage.removeItem('gateToken'); m.textContent = 'Wrong passcode — try again.'; render(); return; }
    if (x.j.error){ m.textContent = x.j.error; load(); return; }
    load();
  })
  .catch(function(){ m.textContent = 'Network error — retry.'; });
}
load();
</script></body></html>`;
app.get("/gate", (_req, res) => res.type("html").send(GATE_HTML));

// Gate fallback page: search a guest by name/phone/email/ticket number when
// their QR isn't available, then tap through to that booking's pass.
const FIND_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="robots" content="noindex">
<title>Arpana Gate — Find a booking</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0605;color:#f4e9d6;font-family:'Outfit','Segoe UI',system-ui,sans-serif;min-height:100vh;padding:22px 14px 60px}
.wrap{max-width:520px;margin:0 auto}
.brand{font-family:Georgia,serif;font-size:1.1rem;text-align:center;margin-bottom:4px}.brand em{color:#e9b04b;font-style:normal}
.sub{text-align:center;font-size:.78rem;letter-spacing:2px;text-transform:uppercase;color:#9a8a6e;margin-bottom:18px}
.searchbar{display:flex;gap:8px;margin-bottom:6px}
input{flex:1;min-width:0;background:#160f0a;border:1px solid #3a2c1a;border-radius:12px;color:#f4e9d6;font-size:17px;padding:15px 16px;font-family:inherit}
input:focus{outline:none;border-color:#e9b04b}
button{background:#e9b04b;color:#160a05;border:0;border-radius:12px;font-size:16px;font-weight:700;padding:15px 20px;font-family:inherit;cursor:pointer}
button:active{transform:translateY(1px)}
.hint{font-size:.8rem;color:#9a8a6e;text-align:center;margin:10px 0 16px;line-height:1.5}
.card{display:block;text-decoration:none;color:inherit;background:#140e0a;border:1px solid #3a2c1a;border-left:5px solid #e9b04b;border-radius:14px;padding:15px 16px;margin-bottom:11px}
.card.done{border-left-color:#8fd67c;opacity:.72}
.card.part{border-left-color:#f0a24b}
.nm{font-size:1.08rem;font-weight:700;margin-bottom:3px}
.meta{font-size:.8rem;color:#9a8a6e;word-break:break-all;line-height:1.5}
.tix{font-size:.78rem;color:#bcae97;margin-top:5px}
.state{display:flex;gap:8px;margin-top:10px;align-items:center}
.pill{font-size:.72rem;letter-spacing:1.2px;text-transform:uppercase;padding:6px 11px;border-radius:999px;background:#241708;color:#e9b04b;border:1px solid #4a3310}
.pill.ok{background:#16240f;color:#8fd67c;border-color:#3f6b33}
.pill.tag{background:#1a1206;color:#9a8a6e;border-color:#3a2c1a}
.go{margin-left:auto;font-size:.8rem;color:#e9b04b;font-weight:700}
.msg{text-align:center;color:#9a8a6e;font-size:.9rem;padding:24px 10px;line-height:1.6}
.back{display:block;text-align:center;color:#9a8a6e;font-size:.82rem;margin-top:22px;text-decoration:none}
</style></head><body><div class="wrap">
<div class="brand">Nrutyapuri <em>Arpana</em></div>
<div class="sub">Find a booking</div>
<div class="searchbar">
  <input id="q" type="search" placeholder="Name, phone, email or ARPANA-0042" autocomplete="off" autocapitalize="off">
  <button onclick="run()">Find</button>
</div>
<div class="hint">Use this when a guest can&rsquo;t show their QR. Tap a result to open their pass and check them in.</div>
<div id="out"></div>
<a class="back" href="/gate">&larr; back to scanning</a>
</div><script>
function esc(x){ return String(x==null?'':x).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function token(){ return localStorage.getItem('gateToken') || ''; }
var out = document.getElementById('out'), q = document.getElementById('q');
function run(){
  var v = q.value.trim();
  if (v.length < 2){ out.innerHTML = '<div class="msg">Type at least 2 characters.</div>'; return; }
  if (!token()){
    var t = prompt('Gate passcode:');
    if (!t) return;
    localStorage.setItem('gateToken', t.trim());
  }
  out.innerHTML = '<div class="msg">Searching&hellip;</div>';
  fetch('/api/arpana/find?q=' + encodeURIComponent(v), { headers: { 'x-admin-token': token() } })
    .then(function(r){
      if (r.status === 401){ localStorage.removeItem('gateToken'); out.innerHTML = '<div class="msg">Wrong passcode &mdash; tap Find to try again.</div>'; return null; }
      return r.json();
    })
    .then(function(j){
      if (!j) return;
      if (!j.matches || !j.matches.length){ out.innerHTML = '<div class="msg">No booking found for &ldquo;' + esc(v) + '&rdquo;.<br>Try their phone number, or part of the name as spelt at booking.</div>'; return; }
      var h = '';
      j.matches.forEach(function(m){
        var cls = m.remaining <= 0 ? 'card done' : (m.checkedIn > 0 ? 'card part' : 'card');
        h += '<a class="' + cls + '" href="' + esc(m.gateUrl) + '">';
        h += '<div class="nm">' + esc(m.name || 'Guest') + '</div>';
        h += '<div class="meta">' + esc(m.email || '') + (m.phone ? ' &middot; ' + esc(m.phone) : '') + '</div>';
        h += '<div class="tix">' + esc((m.ticketNumbers || []).join(', ')) + '</div>';
        h += '<div class="state">';
        h += m.remaining <= 0
          ? '<span class="pill ok">All ' + m.qty + ' entered</span>'
          : '<span class="pill">' + m.remaining + ' of ' + m.qty + ' left</span>';
        if (m.comp) h += '<span class="pill tag">Guest</span>';
        h += '<span class="go">' + (m.remaining <= 0 ? 'View' : 'Check in &rarr;') + '</span>';
        h += '</div></a>';
      });
      if (j.truncated) h += '<div class="msg">Showing 12 of ' + j.total + ' matches &mdash; type more to narrow it down.</div>';
      out.innerHTML = h;
    })
    .catch(function(){ out.innerHTML = '<div class="msg">Network problem &mdash; check the connection and try again.</div>'; });
}
q.addEventListener('keydown', function(e){ if (e.key === 'Enter') run(); });
q.focus();
</script></body></html>`;
app.get("/gate/find", (_req, res) => res.type("html").send(FIND_HTML));

app.listen(PORT, async () => {
  console.log(`\n  Arpana ticket-server on :${PORT}`);
  await reconcileEmails(); // rebuild ledger + send any missed ticket emails
  console.log(`  ${remaining()}/${TOTAL} tickets available\n`);
  setInterval(() => reconcileEmails().catch((e) => console.warn("reconcile error:", e.message)), 10 * 60 * 1000);
});
