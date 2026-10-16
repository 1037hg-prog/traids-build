#!/usr/bin/env node
/**
 * TRAIDS VERIFICATION API v1 (2026-09-22). A separate service — it never touches the :3001 server, the signal watcher or any ledger.
 * Binds 127.0.0.1 only: this is for the operator's own use until the data-vendor licence question is settled (see the README note below).
 *
 *   node backend/verify-api.js --new-key "<label>"   create an API key (printed ONCE; only its SHA-256 is stored)
 *   node backend/verify-api.js                        start on 127.0.0.1:3011 (VERIFY_API_PORT to change)
 *
 * Endpoints (all but /v1/health need header  x-api-key: <key>):
 *   GET  /v1/health
 *   POST /v1/track-records            body = the CSV text (Content-Type text/csv or text/plain), or JSON { "csv": "..." }  -> 202 { jobId }
 *   GET  /v1/jobs/:id                 -> { status: queued|running|done|failed, result? }
 *   POST /v1/registration-requests    JSON { jobId, name, notes }  -> a PENDING request; nothing is registered without the operator
 * Limits: per-key token bucket (default 10 requests/minute), one running job per key, 5 MB bodies, 5,000 trades per record.
 *
 * LICENCE NOTE: results are DERIVED from Alpaca / Massive data (in-range or not, cost-repriced P&L); raw bars are never returned. Whether
 * even derived results may be served to outside users under those vendors' terms is NOT settled — the operator decides before any
 * outside key is issued. Collective2 data enters only as a CSV the user supplies; this service never fetches from collective2.com.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const D = (f) => path.join(__dirname, "data", f);
const KEYS = D("verify-api-keys.json"), REQS = D("verify-registration-requests.jsonl"), LOG = D("verify-api-log.jsonl");
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const readKeys = () => { try { return JSON.parse(fs.readFileSync(KEYS, "utf8")).keys || []; } catch { return []; } };

if (process.argv[2] === "--new-key") {
  const label = String(process.argv[3] || "").trim(); if (!label) { console.error('usage: node backend/verify-api.js --new-key "<label>"'); process.exit(2); }
  const key = "tv1_" + crypto.randomBytes(24).toString("base64url"), keys = readKeys();
  keys.push({ id: crypto.randomBytes(4).toString("hex"), label, sha256: sha(key), ratePerMin: 10, created: new Date().toISOString() });
  fs.writeFileSync(KEYS, JSON.stringify({ note: "SHA-256 of each key only; the key itself is shown once at creation", keys }, null, 1));
  console.log(`key for "${label}" (shown once — store it now):\n${key}`); process.exit(0);
}

const express = require("express"); const VD = require("./lib/verify-data"); const V = require("./lib/verify");
const app = express(), PORT = Number(process.env.VERIFY_API_PORT || 3011), MAX_TRADES = 5000;
const keys = readKeys(); if (!keys.length) { console.error("No API keys — refusing to start. Create one: node backend/verify-api.js --new-key \"operator\""); process.exit(2); }
const log = (row) => { try { fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n"); } catch {} };

// ---- auth + rate limit ---------------------------------------------------------------------------------------------------------------
const buckets = new Map();
function auth(req, res, next) {
  const k = req.get("x-api-key"); const rec = k && keys.find((x) => crypto.timingSafeEqual(Buffer.from(x.sha256), Buffer.from(sha(k))));
  if (!rec) { log({ path: req.path, status: 401 }); return res.status(401).json({ error: "missing or invalid x-api-key" }); }
  const now = Date.now(), b = buckets.get(rec.id) || { tokens: rec.ratePerMin, at: now }; b.tokens = Math.min(rec.ratePerMin, b.tokens + ((now - b.at) / 60000) * rec.ratePerMin); b.at = now;
  if (b.tokens < 1) { buckets.set(rec.id, b); res.set("Retry-After", String(Math.ceil((1 - b.tokens) * 60 / rec.ratePerMin))); log({ key: rec.id, path: req.path, status: 429 }); return res.status(429).json({ error: "rate limit — try again shortly" }); }
  b.tokens -= 1; buckets.set(rec.id, b); req.keyRec = rec; next();
}
app.use(express.text({ type: ["text/*", "application/csv"], limit: "5mb" })); app.use(express.json({ limit: "5mb" }));

// ---- jobs ---------------------------------------------------------------------------------------------------------------------------------
const jobs = new Map(); const running = new Set();
app.get("/v1/health", (req, res) => res.json({ ok: true, service: "traids-verify", version: "v1", jobs: jobs.size }));
app.post("/v1/track-records", auth, (req, res) => {
  const text = typeof req.body === "string" ? req.body : req.body && typeof req.body.csv === "string" ? req.body.csv : null;
  if (!text) return res.status(400).json({ error: "send the CSV as the body (text/csv) or as JSON { csv }" });
  const parsed = V.parseTrackRecord(text); if (!parsed.trades.length) return res.status(422).json({ error: "no readable trades", warnings: parsed.warnings.slice(0, 20) });
  if (parsed.trades.length > MAX_TRADES) return res.status(413).json({ error: `record has ${parsed.trades.length} trades; the limit is ${MAX_TRADES}` });
  if (running.has(req.keyRec.id)) return res.status(409).json({ error: "a job for this key is still running" });
  const id = crypto.randomBytes(8).toString("hex"), job = { id, key: req.keyRec.id, status: "queued", submitted: new Date().toISOString(), trades: parsed.trades.length, progress: [] };
  jobs.set(id, job); running.add(req.keyRec.id); log({ key: req.keyRec.id, path: req.path, status: 202, job: id, trades: parsed.trades.length });
  (async () => { job.status = "running";
    try { job.result = await VD.verifyText(text, { log: (m) => job.progress.push(m) }); job.status = "done"; }
    catch (e) { job.status = "failed"; job.error = String(e.message).slice(0, 300); }
    finally { running.delete(req.keyRec.id); job.finished = new Date().toISOString(); } })();
  res.status(202).json({ jobId: id, status: "queued", poll: `/v1/jobs/${id}` });
});
app.get("/v1/jobs/:id", auth, (req, res) => {
  const j = jobs.get(req.params.id); if (!j || j.key !== req.keyRec.id) return res.status(404).json({ error: "no such job for this key" });
  res.json({ jobId: j.id, status: j.status, submitted: j.submitted, finished: j.finished || null, trades: j.trades, progress: j.progress.slice(-5), error: j.error || null, result: j.status === "done" ? j.result : null });
});
app.post("/v1/registration-requests", auth, (req, res) => {
  const { jobId, name, notes } = req.body || {}; const j = jobs.get(jobId);
  if (!j || j.key !== req.keyRec.id || j.status !== "done") return res.status(400).json({ error: "jobId must be a finished job of this key" });
  const request = V.registrationRequest({ format: j.result.format, trades: j.result.trades, fillCheck: j.result.fillCheck }, { name, notes, requester: req.keyRec.label });
  const row = { id: crypto.randomBytes(6).toString("hex"), jobId, ...request }; fs.appendFileSync(REQS, JSON.stringify(row) + "\n"); log({ key: req.keyRec.id, path: req.path, status: 201, request: row.id });
  res.status(201).json(row);
});
app.use((req, res) => res.status(404).json({ error: "not found", see: ["/v1/health", "POST /v1/track-records", "GET /v1/jobs/:id", "POST /v1/registration-requests"] }));
app.listen(PORT, "127.0.0.1", () => console.log(`traids-verify v1 on http://127.0.0.1:${PORT} · ${keys.length} key(s)`));
