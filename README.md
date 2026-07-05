# Nrutyapuri Dance Academy — website + local CMS

A self-contained website (`nrutyapuri-nextgen.html`) with a small **local CMS**
to manage the **Gallery photos, Performance videos, and Past Events**. Nothing
runs in the cloud and there are no subscriptions — the CMS lives on your machine.

## Run the CMS

```bash
cd cms
npm install      # first time only
npm run cms
```

Then open:

- **Dashboard** → http://localhost:4321/admin — upload / rename / reorder / delete photos & videos
- **Website preview** → http://localhost:4321/ — see the site with your media live

### How it works
- Photos upload to `media/photos/`, videos to `media/videos/`.
- **Past Events** are text records (title, category, date, venue, participants, description, highlights) — no upload needed.
- The dashboard writes `content/gallery.json`, `content/videos.json`, and `content/events.json`.
- The website reads those JSON files and renders the **Gallery**, **Films**, and **Past Events** sections automatically — you never edit HTML.

### Publishing to the live site
Click **“Publish to live”** in the dashboard (commits everything and pushes to
GitHub), or do it manually:

```bash
git add -A && git commit -m "Add new gallery photos" && git push
```

> ⚠️ **Videos are large.** GitHub rejects single files over 100 MB and free
> hosts have bandwidth limits. Keep clips short/compressed, or switch large
> videos to YouTube/Vimeo embeds later (ask and I’ll wire that up).

## Important
- View the site through **http://localhost:4321/** (or your live host), not by
  double-clicking the HTML file — browsers block the gallery from loading data
  over `file://`.
- The CMS is for **local use only**; never deploy the `cms/` folder publicly.
