# Arpana ticket-server

Backend for Arpana ticketing: creates Razorpay UPI orders, verifies payments
server-side, generates ticket numbers, emails the buyer + academy, and tracks
remaining inventory (rebuilt from Razorpay so it survives restarts).

The public website (`../index.html`) calls this API. It stays disabled on the
site until you set `apiBase` in `../content/arpana.json` to this server's URL.

## Going live — one time setup

### 1. Razorpay (payments)
1. Create a free account at https://razorpay.com and complete KYC to accept live UPI.
2. Dashboard → **Settings → API Keys → Generate Key**. Copy **Key Id** + **Key Secret**.
   - Use **Test Mode** keys first to try everything without real money.

### 2. Gmail (ticket emails)
1. On `nrutyapuridanceacademy@gmail.com`, turn on **2-Step Verification**.
2. Create an **App Password**: https://myaccount.google.com/apppasswords → copy the 16-char code.
   Set both `GMAIL_USER` and `ACADEMY_EMAIL` to `nrutyapuridanceacademy@gmail.com`.

### 3. Deploy to Render (free)
1. Go to https://render.com → **New → Blueprint** → connect this GitHub repo.
   Render reads `render.yaml` and creates the service automatically.
2. In the service's **Environment**, fill the secret vars:
   `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`,
   `ACADEMY_EMAIL`, and optionally `EVENT_DATE`, `EVENT_VENUE`.
3. Deploy. You'll get a URL like `https://nrutyapuri-ticket-server.onrender.com`.

### 4. Point the website at it
Edit `../content/arpana.json` → set `"apiBase": "https://<your-service>.onrender.com"`,
commit & push. The Buy button goes live.

> Free tier note: the service sleeps after ~15 min idle, so the first booking
> after a quiet spell takes ~30s to wake. Inventory is safe — it's rebuilt from
> Razorpay's record of paid orders on every start.

## Run locally (testing)
```bash
cd ticket-server
cp .env.example .env      # fill in TEST Razorpay keys + Gmail app password
npm install
node --env-file=.env server.js
```
Then set `apiBase` to `http://localhost:8080` and open the site over `http://localhost:...` (the CMS server) — not `file://` — to test the flow with Razorpay Test Mode.

## API
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/arpana/status` | `{ total, sold, remaining, priceINR }` |
| POST | `/api/arpana/order` | body `{name,email,phone,qty}` → creates Razorpay order |
| POST | `/api/arpana/verify` | verifies signature, allocates ticket #, emails |

Security: payment is verified by HMAC signature server-side; quantity is taken
from the paid Razorpay order (not the browser); all secrets are env-only.
