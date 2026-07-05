/**
 * Nrutyapuri — local CMS server.
 *
 * Runs only on your machine. Serves:
 *   /          → the live website (with gallery/videos pulled from content/*.json)
 *   /admin     → the CMS dashboard to upload & manage photos and videos
 *   /api/*     → JSON + upload/delete/reorder endpoints used by the dashboard
 *
 * Media is saved into  ../media/photos  and  ../media/videos
 * Data is written to   ../content/gallery.json  and  ../content/videos.json
 * Nothing leaves your computer until you choose to commit/push to GitHub.
 */
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // the site repo root
const CONTENT = path.join(ROOT, "content");
const MEDIA = path.join(ROOT, "media");
const PORT = process.env.PORT || 4321;

const TYPES = {
  gallery: { json: path.join(CONTENT, "gallery.json"), dir: path.join(MEDIA, "photos"), rel: "media/photos" },
  videos: { json: path.join(CONTENT, "videos.json"), dir: path.join(MEDIA, "videos"), rel: "media/videos" },
};

// --- tiny JSON helpers ---
const readItems = (type) => {
  try {
    return JSON.parse(fs.readFileSync(TYPES[type].json, "utf8")).items || [];
  } catch {
    return [];
  }
};
const writeItems = (type, items) =>
  fs.writeFileSync(TYPES[type].json, JSON.stringify({ items }, null, 2));

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";

// --- uploads ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = req.params.type;
    if (!TYPES[type]) return cb(new Error("bad type"));
    fs.mkdirSync(TYPES[type].dir, { recursive: true });
    cb(null, TYPES[type].dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = slugify(path.basename(file.originalname, ext));
    cb(null, `${Date.now()}-${base}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 600 * 1024 * 1024 } }); // 600MB cap

const app = express();
app.use(express.json());

// Serve the website + its assets/media/content from the repo root.
app.use(express.static(ROOT, { index: false }));
app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "nrutyapuri-nextgen.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "admin.html")));

// --- Events (structured records, no file upload) ---
const EVENTS_JSON = path.join(CONTENT, "events.json");
const readEvents = () => {
  try { return JSON.parse(fs.readFileSync(EVENTS_JSON, "utf8")).items || []; }
  catch { return []; }
};
const writeEvents = (items) => fs.writeFileSync(EVENTS_JSON, JSON.stringify({ items }, null, 2));
const toHighlights = (v) =>
  Array.isArray(v) ? v : (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : []);

app.get("/api/events", (_req, res) => res.json({ items: readEvents() }));

app.post("/api/events", (req, res) => {
  const b = req.body || {};
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: (b.title || "Untitled event").trim(),
    category: (b.category || "Performance").trim(),
    date: (b.date || "").trim(),
    venue: (b.venue || "").trim(),
    participants: (b.participants || "").trim(),
    description: (b.description || "").trim(),
    highlights: toHighlights(b.highlights),
    ts: Date.now(),
  };
  writeEvents([...readEvents(), item]);
  res.json({ ok: true, item });
});

app.post("/api/events/reorder", (req, res) => {
  const items = readEvents();
  const order = req.body.ids || [];
  items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  writeEvents(items);
  res.json({ ok: true });
});

app.patch("/api/events/:id", (req, res) => {
  const items = readEvents();
  const it = items.find((x) => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: "not found" });
  const b = req.body || {};
  ["title", "category", "date", "venue", "participants", "description"].forEach((k) => {
    if (typeof b[k] === "string") it[k] = b[k];
  });
  if (b.highlights !== undefined) it.highlights = toHighlights(b.highlights);
  writeEvents(items);
  res.json({ ok: true, item: it });
});

app.delete("/api/events/:id", (req, res) => {
  writeEvents(readEvents().filter((x) => x.id !== req.params.id));
  res.json({ ok: true });
});

// List
app.get("/api/:type", (req, res) => {
  if (!TYPES[req.params.type]) return res.status(404).json({ error: "unknown type" });
  res.json({ items: readItems(req.params.type) });
});

// Upload (one or more files)
app.post("/api/:type", upload.array("files", 30), (req, res) => {
  const type = req.params.type;
  if (!TYPES[type]) return res.status(404).json({ error: "unknown type" });
  const items = readItems(type);
  const title = (req.body.title || "").trim();
  const category = (req.body.category || "").trim();
  const added = (req.files || []).map((f, i) => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${i}`,
    file: `${TYPES[type].rel}/${f.filename}`,
    title: title || path.basename(f.originalname, path.extname(f.originalname)),
    category: category || (type === "gallery" ? "Gallery" : "Performance"),
    ts: Date.now(),
  }));
  writeItems(type, [...items, ...added]);
  res.json({ ok: true, added });
});

// Update title/category
app.patch("/api/:type/:id", (req, res) => {
  const { type, id } = req.params;
  if (!TYPES[type]) return res.status(404).json({ error: "unknown type" });
  const items = readItems(type);
  const it = items.find((x) => x.id === id);
  if (!it) return res.status(404).json({ error: "not found" });
  if (typeof req.body.title === "string") it.title = req.body.title;
  if (typeof req.body.category === "string") it.category = req.body.category;
  writeItems(type, items);
  res.json({ ok: true, item: it });
});

// Reorder — body { ids: [...] }
app.post("/api/:type/reorder", (req, res) => {
  const { type } = req.params;
  if (!TYPES[type]) return res.status(404).json({ error: "unknown type" });
  const items = readItems(type);
  const order = req.body.ids || [];
  items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  writeItems(type, items);
  res.json({ ok: true });
});

// Delete (removes entry + file)
app.delete("/api/:type/:id", (req, res) => {
  const { type, id } = req.params;
  if (!TYPES[type]) return res.status(404).json({ error: "unknown type" });
  const items = readItems(type);
  const it = items.find((x) => x.id === id);
  if (it) {
    const abs = path.join(ROOT, it.file);
    if (abs.startsWith(MEDIA) && fs.existsSync(abs)) {
      try { fs.unlinkSync(abs); } catch {}
    }
  }
  writeItems(type, items.filter((x) => x.id !== id));
  res.json({ ok: true });
});

// Publish — commit & push to GitHub (optional convenience)
app.post("/api/publish", (req, res) => {
  const msg = (req.body && req.body.message) || "Update gallery/videos via CMS";
  execFile("git", ["-C", ROOT, "add", "-A"], (e1) => {
    if (e1) return res.status(500).json({ error: String(e1) });
    execFile("git", ["-C", ROOT, "commit", "-m", msg], (e2, out2, err2) => {
      // commit may fail if nothing changed — treat that as ok
      if (e2 && !/nothing to commit/i.test(err2 + out2)) {
        return res.status(500).json({ error: (err2 || out2 || String(e2)).trim() });
      }
      execFile("git", ["-C", ROOT, "push", "origin", "HEAD"], (e3, out3, err3) => {
        if (e3) return res.status(500).json({ error: (err3 || String(e3)).trim() });
        res.json({ ok: true, output: (out3 || err3 || "pushed").trim() });
      });
    });
  });
});

app.listen(PORT, () => {
  console.log(`\n  Nrutyapuri CMS running`);
  console.log(`  • Website : http://localhost:${PORT}/`);
  console.log(`  • Dashboard: http://localhost:${PORT}/admin\n`);
});
