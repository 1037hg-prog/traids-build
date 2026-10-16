/**
 * TRAIDS Assessment Agents — standalone multi-provider panel service.
 *
 * Runs independently of the Claude Code app and the main TRAIDS backend — deploy on
 * any outside server with Node 18+. Calls Claude / OpenAI / Gemini / Ollama in parallel
 * (whichever keys are set) for each validator role, aggregates, and logs an audit trail.
 *
 * HONEST LANE: a risk-check & compliance-documentation layer, NOT an edge generator.
 *
 *   POST /assess   { input: <trade|strategy|backtest object or text>, roles?, providers? }
 *   GET  /trail    ?limit=50        → recent assessments (the audit trail)
 *   GET  /health                    → providers enabled, auth status
 *
 * Run:  npm install && npm start          (set .env first — see .env.example)
 */
(function loadEnv() { try { const fs = require("fs"), path = require("path"); for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {} })();

const express = require("express");
const fs = require("fs");
const { runPanel, TRAIL } = require("./orchestrator");
const { enabledProviders } = require("./providers");

const PORT = parseInt(process.env.ASSESS_PORT || "3010");
const TOKEN = process.env.ASSESS_API_TOKEN || "";

// keep the service alive — a stray provider/network error must never kill it
process.on("unhandledRejection", e => console.error("[Assess] unhandledRejection (ignored):", e?.message || e));
process.on("uncaughtException", e => { console.error("[Assess] uncaughtException — exiting for restart:", e?.message || e); process.exit(1); });

const app = express();
app.use(express.json({ limit: "1mb" }));

// bearer auth (REQUIRED before exposing publicly; /health is always open)
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!TOKEN) return next();   // boot warns loudly if unset
  if ((req.headers.authorization || "") === `Bearer ${TOKEN}`) return next();
  return res.status(401).json({ error: "unauthorized — send Authorization: Bearer <ASSESS_API_TOKEN>" });
});

// simple per-IP rate limit
const hits = new Map();
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const ip = req.ip || "x", now = Date.now(), win = 60000, max = parseInt(process.env.ASSESS_RATE || "20");
  const arr = (hits.get(ip) || []).filter(t => now - t < win); arr.push(now); hits.set(ip, arr);
  if (arr.length > max) return res.status(429).json({ error: "rate limited (per-minute cap)" });
  next();
});

app.get("/health", (_, res) => res.json({ status: "ok", service: "traids-assessment-agents", providers: enabledProviders(), auth: !!TOKEN }));

app.post("/assess", async (req, res) => {
  try {
    const item = req.body?.input ?? req.body?.payload;
    if (item == null) return res.status(400).json({ error: "body.input required — the trade/strategy/backtest to assess (object or text)" });
    const record = await runPanel(item, { roles: req.body?.roles, providers: req.body?.providers });
    res.json(record);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/trail", (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const lines = fs.existsSync(TRAIL) ? fs.readFileSync(TRAIL, "utf8").trim().split("\n").filter(Boolean) : [];
    res.json(lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  const provs = enabledProviders();
  console.log(`\n  TRAIDS Assessment Agents — multi-provider panel · :${PORT}`);
  console.log(`  providers: ${provs.length ? provs.join(", ") : "*** NONE — set API keys in .env ***"}`);
  console.log(`  auth:      ${TOKEN ? "ON (Bearer token)" : "*** OFF — set ASSESS_API_TOKEN before exposing publicly ***"}`);
  console.log(`  routes:    POST /assess · GET /trail · GET /health\n`);
});

// OPTIONAL autonomous mode — watch a JSON file of items and assess new ones on an
// interval (e.g., point it at the day's trades during the 30-day live test).
if (process.env.ASSESS_WATCH_FILE && process.env.ASSESS_INTERVAL_SEC) {
  const wf = process.env.ASSESS_WATCH_FILE, iv = Math.max(30, parseInt(process.env.ASSESS_INTERVAL_SEC)) * 1000;
  const seen = new Set();
  console.log(`  autonomous mode: watching ${wf} every ${iv / 1000}s`);
  setInterval(async () => {
    try {
      const items = JSON.parse(fs.readFileSync(wf, "utf8"));
      for (const it of (Array.isArray(items) ? items : [])) {
        const id = it.id || JSON.stringify(it).slice(0, 80);
        if (seen.has(id)) continue; seen.add(id);
        await runPanel(it, {});
        console.log(`[Assess] auto-assessed ${id}`);
      }
    } catch (e) { console.error("[Assess] watch error:", e.message); }
  }, iv);
}
