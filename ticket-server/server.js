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
const mailer = (MAIL_HOOK_URL && MAIL_HOOK_SECRET) || smtpMailer ? {} : null; // truthy flag: some mail path exists
if (!mailer) console.warn("⚠  No mail path configured (MAIL_HOOK_URL/SECRET or GMAIL creds) — emails disabled.");

// Deliver a batch of {to, subject, html} messages; returns [{to, ok, error?}]
async function deliverMail(messages) {
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
    try { await smtpMailer.sendMail({ from, ...m }); out.push({ to: m.to, ok: true }); }
    catch (e) { out.push({ to: m.to, ok: false, error: e.message }); }
  }
  return out;
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
        if (o.status === "paid" && o.notes && o.notes.event === EVENT_NAME) paid.push(o);
      }
      more = items.length === 100;
      skip += 100;
    }
    paid.sort((a, b) => a.created_at - b.created_at);
    const l = { sold: 0, records: [] };
    for (const o of paid) {
      const qty = parseInt(o.notes.qty, 10) || 1;
      const nums = [];
      for (let i = 0; i < qty; i++) { l.sold += 1; nums.push(`${PREFIX}-${pad(l.sold)}`); }
      l.records.push({ ticketNumbers: nums, name: o.notes.name || "", email: o.notes.email || "", phone: o.notes.phone || "", qty, amount: o.amount / 100, orderId: o.id, ts: o.created_at * 1000 });
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
async function sendTicketEmails({ name, email, phone, qty, amount, ticketNumbers, orderId }) {
  if (!mailer) return;
  const nums = ticketNumbers.join(", ");
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
          <div style="font-size:12px;letter-spacing:3px;color:#3d2208;text-transform:uppercase;padding-top:4px">The Temple of Motion · Hyderabad</div>
        </td>
      </tr>
      <!-- body -->
      <tr>
        <td style="background:#0f0a08;border:1px solid #2e2314;border-top:0;padding:30px;font-family:Arial,Helvetica,sans-serif;color:#f4e9d6">
          <div style="text-align:center;padding-bottom:22px">
            <div style="display:inline-block;width:54px;height:54px;line-height:54px;border-radius:50%;background:#1d2b17;border:1px solid #3f6b33;color:#8fd67c;font-size:26px">&#10003;</div>
            <div style="font-size:20px;font-weight:bold;padding-top:12px">Booking Confirmed</div>
            <div style="font-size:13px;color:#bcae97;padding-top:4px">Namaste ${name}, your payment of <b style="color:#f3cf8e">&#8377;${amount}</b> was successful.</div>
          </div>

          <div style="font-size:11px;letter-spacing:2.5px;color:#9a8a6e;text-transform:uppercase;padding:6px 0 12px">Your ticket${qty > 1 ? "s" : ""}</div>
          ${ticketCards}

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
                  <td style="padding:7px 0;color:#f4e9d6;text-align:right;border-top:1px solid #241a10">${EVENT_VENUE || "To be announced"}</td>
                </tr>
                <tr>
                  <td style="padding:7px 0;color:#bcae97;border-top:1px solid #241a10">Tickets</td>
                  <td style="padding:7px 0;color:#f4e9d6;text-align:right;border-top:1px solid #241a10">${qty} &times; &#8377;${PRICE}</td>
                </tr>
                <tr>
                  <td style="padding:7px 0;color:#bcae97;border-top:1px solid #241a10">Amount paid</td>
                  <td style="padding:7px 0;color:#8fd67c;text-align:right;font-weight:bold;border-top:1px solid #241a10">&#8377;${amount}</td>
                </tr>
                <tr>
                  <td style="padding:7px 0;color:#bcae97;border-top:1px solid #241a10">Order ref</td>
                  <td style="padding:7px 0;color:#7d715e;text-align:right;font-size:12px;border-top:1px solid #241a10">${orderId}</td>
                </tr>
              </table>
            </td></tr>
          </table>

          <div style="margin-top:22px;background:#1a1206;border:1px solid #3a2c1a;border-radius:10px;padding:14px 18px;font-size:13px;color:#d8c9a8;line-height:1.6">
            &#128278; <b>At the venue:</b> show this email or quote your ticket number at entry. Each ticket admits one person.
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
      <h2>New ${EVENT_NAME} booking</h2>
      <p><b>${name}</b> booked <b>${qty}</b> ticket(s) — ₹${amount}</p>
      <ul>
        <li>Tickets: ${nums}</li>
        <li>Email: ${email}</li>
        <li>Phone: ${phone}</li>
        <li>Order: ${orderId}</li>
      </ul>
      <p>Sold so far: ${ledger.sold}/${TOTAL} (${remaining()} left)</p>
    </div>`;
  const messages = [
    { to: email, subject: `Your ${EVENT_NAME} ticket${qty > 1 ? "s" : ""} — ${nums}`, html: buyerHtml },
  ];
  if (ACADEMY_EMAIL)
    messages.push({ to: ACADEMY_EMAIL, subject: `New ${EVENT_NAME} booking — ${name} × ${qty}`, html: academyHtml });
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

app.listen(PORT, async () => {
  console.log(`\n  Arpana ticket-server on :${PORT}`);
  await reconcileEmails(); // rebuild ledger + send any missed ticket emails
  console.log(`  ${remaining()}/${TOTAL} tickets available\n`);
  setInterval(() => reconcileEmails().catch((e) => console.warn("reconcile error:", e.message)), 10 * 60 * 1000);
});
