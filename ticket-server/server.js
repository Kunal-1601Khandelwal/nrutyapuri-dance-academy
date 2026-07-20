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

const mailer =
  env.GMAIL_USER && env.GMAIL_APP_PASSWORD
    ? nodemailer.createTransport({ service: "gmail", auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD } })
    : null;
if (!mailer) console.warn("⚠  GMAIL_USER / _APP_PASSWORD not set — emails disabled.");

// ---------- ledger ----------
const readLedger = () => { try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); } catch { return { sold: 0, records: [] }; } };
const writeLedger = (l) => fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2));
let ledger = readLedger();
const remaining = () => TOTAL - ledger.sold;

// Rebuild the ledger from Razorpay's paid orders (source of truth, deterministic by time).
async function rebuildFromRazorpay() {
  if (!razorpay) return;
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
  } catch (e) {
    console.warn("Rebuild skipped:", e.message);
  }
}

// ---------- emails ----------
async function sendTicketEmails({ name, email, phone, qty, amount, ticketNumbers, orderId }) {
  if (!mailer) return;
  const when = [EVENT_DATE, EVENT_VENUE].filter(Boolean).join(" · ");
  const nums = ticketNumbers.join(", ");
  const buyerHtml = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;background:#0c0807;color:#f4e9d6;border-radius:16px;overflow:hidden;border:1px solid rgba(233,176,75,.25)">
      <div style="background:linear-gradient(120deg,#e9b04b,#ff5e2b);color:#160a05;padding:22px 26px;font-size:22px;font-weight:700">Nrutyapuri · ${EVENT_NAME}</div>
      <div style="padding:26px">
        <p>Namaste ${name},</p>
        <p>Your payment was successful. Here ${qty > 1 ? "are your tickets" : "is your ticket"}:</p>
        <p style="font-size:22px;color:#f3cf8e;letter-spacing:.06em;font-weight:bold">${nums}</p>
        <table style="width:100%;font-size:14px;color:#bcae97;margin-top:14px">
          <tr><td>Tickets</td><td style="text-align:right;color:#f4e9d6">${qty}</td></tr>
          <tr><td>Amount paid</td><td style="text-align:right;color:#f4e9d6">₹${amount}</td></tr>
          ${when ? `<tr><td>Event</td><td style="text-align:right;color:#f4e9d6">${when}</td></tr>` : ""}
          <tr><td>Order</td><td style="text-align:right;color:#f4e9d6">${orderId}</td></tr>
        </table>
        <p style="margin-top:20px;color:#bcae97;font-size:13px">Please carry this email (or the ticket number) to the venue. See you at ${EVENT_NAME}!</p>
      </div>
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
  const from = `"Nrutyapuri Dance Academy" <${env.GMAIL_USER}>`;
  await Promise.allSettled([
    mailer.sendMail({ from, to: email, subject: `Your ${EVENT_NAME} ticket${qty > 1 ? "s" : ""} — ${nums}`, html: buyerHtml }),
    ACADEMY_EMAIL && mailer.sendMail({ from, to: ACADEMY_EMAIL, subject: `New ${EVENT_NAME} booking — ${name} × ${qty}`, html: academyHtml }),
  ].filter(Boolean));
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

    // 5) email (don't block the response on mail delivery)
    sendTicketEmails(rec).catch((e) => console.warn("mail error:", e.message));

    res.json({ ticketNumbers: nums });
  } catch (e) {
    res.status(500).json({ error: "Verification error. " + e.message });
  }
});

app.listen(PORT, async () => {
  console.log(`\n  Arpana ticket-server on :${PORT}`);
  await rebuildFromRazorpay();
  console.log(`  ${remaining()}/${TOTAL} tickets available\n`);
});
