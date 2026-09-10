# Nrutyapuri Dance Academy — nrutyapuri.in

Static website for the Odissi dance academy in Hyderabad, hosted on Netlify.
The publish directory is the repo root; hosting rules live in `netlify.toml`.

## Pages

- `index.html` — the single-page site: hero, About, Our Guru, Programs, Gallery and the
  "Join Us" enquiry form (opens a pre-filled WhatsApp chat). Inline CSS/JS; three.js and GSAP
  load from cdnjs. The gallery is rendered from `content/gallery.json`.
- `contact.html`, `terms.html`, `privacy.html`, `refund.html` — standalone pages in the same
  palette. Light/dark follows the `nda-theme` localStorage key set by the home-page toggle.
- `404.html` — branded not-found page. Netlify serves it for unknown paths and for the
  force-404 rules below.
- `robots.txt`, `sitemap.xml` — crawl rules and the sitemap.
- `bookings.html` — **private admin dashboard** left over from the finished Arpana ticketing.
  It is not linked from the site, is not listed in `robots.txt` (that would advertise the path) and is
  served with an `X-Robots-Tag: noindex, nofollow` header from `netlify.toml`. Leave it untouched.

## Content and media

- `media/photos/` — gallery photos, listed in `content/gallery.json`.
- `media/thumbs/` — 240px copies of `media/photos/` with the same basenames, used by the gallery strip
  and the blurred slide backdrops. The CMS does not create them: after adding photos run
  `scripts/make-thumbs.sh` (macOS `sips`; only creates thumbs that are missing) and commit them with the
  photos. A photo without a thumb still works — the strip and backdrop fall back to the full-size file.
- `cms/` — local-only CMS that manages the photos and writes `content/gallery.json` and
  `content/videos.json`. Run `cd cms && npm install && npm run cms` then open http://localhost:4321/admin.
  It never runs on Netlify and is force-404'd on the live site.
- `ticket-server/` — retired Node backend for Arpana ticketing (was on Render). Reference only.

## Hosting rules (`netlify.toml`)

- Security headers on every path (nosniff, DENY framing, strict referrer, no camera/mic/geo).
- Caching: `/media/*` and `/nrutyapuri-assets/*` for a week, `/content/*` for 5 minutes.
- `/bookings.html` is sent with `X-Robots-Tag: noindex, nofollow`.
- `nrutyapuri.netlify.app/*` redirects (301) to `nrutyapuri.in`.
- `/ticket-server/*`, `/cms/*`, `/netlify/*`, `/.github/*`, `README.md`, `package.json`,
  `package-lock.json`, `netlify.toml`, `render.yaml` and `content/events.json` are force-404'd
  so backend and CMS source is never served publicly.

## Deploying

Deploys are manual and always made from a fresh `git archive` of the committed tree, so
untracked files (`node_modules`, `.env`, local media) never reach Netlify:

```bash
STAGE=$(mktemp -d)
git archive HEAD | tar -x -C "$STAGE"
netlify deploy --prod --dir "$STAGE"
```

Anything not committed does not ship. Do not deploy the working directory directly.
