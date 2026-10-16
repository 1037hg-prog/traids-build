#!/usr/bin/env node
/**
 * HEADLESS RENDER SMOKE of the 2026-10-01 frontend fixes (audit 2026-09-30, frontend#1 #2 #4 #5).
 * Bundles an App.jsx (default src/App.jsx) with esbuild into the OS temp dir, opens it in Playwright's
 * headless Chromium at a FAKE origin (http://traids.test) and intercepts EVERY request:
 *   GET  /api/tradelog          → backend/data/trade_log.json read from disk (scenario "server"), or HTTP 503 ("down")
 *   GET  /api/board-positions   → backend/data/board_positions.json read from disk (tombstones applied)
 *   GET  /api/equities/snapshot, /api/option-quotes → forwarded READ-ONLY to http://localhost:3001 (only with --quotes; else {})
 *   any other GET               → 404;   any POST/PUT/DELETE → answered locally {ok}, NEVER forwarded (and logged)
 *   any other host / websocket  → aborted
 * No server is started or touched; no file is written outside the temp dir.
 *
 *   node docs/audit-fixes/2026-09-30/frontend/smoke-render.cjs [--app <App.jsx>] [--quotes]
 * Exit: 0 PASS · 1 FAIL · 2 UNKNOWN (could not run; as loud as FAIL).
 */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const REPO = path.resolve(__dirname, "..", "..", "..", "..");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const APP = path.resolve(arg("--app", path.join(REPO, "src", "App.jsx")));
const QUOTES = process.argv.includes("--quotes");
const results = []; const verdict = (name, st, detail) => { results.push(st); console.log(`[${st}] ${name}${detail ? " — " + detail : ""}`); };

(async () => {
  let esbuild, chromium;
  try { esbuild = require(path.join(REPO, "node_modules", "esbuild")); ({ chromium } = require(path.join(REPO, "node_modules", "playwright"))); }
  catch (e) { verdict("load esbuild/playwright", "UNKNOWN", e.message); process.exit(2); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "traids-fe-smoke-"));
  fs.cpSync(path.join(REPO, "src"), path.join(tmp, "src"), { recursive: true });
  fs.copyFileSync(APP, path.join(tmp, "src", "App.jsx"));
  try {
    await esbuild.build({ entryPoints: [path.join(tmp, "src", "main.jsx")], bundle: true, outfile: path.join(tmp, "out.js"), format: "esm",
      loader: { ".jsx": "jsx", ".js": "jsx", ".css": "empty" }, jsx: "automatic", nodePaths: [path.join(REPO, "node_modules")], logLevel: "error",
      define: { "process.env.NODE_ENV": '"production"' } });
  } catch (e) { verdict("bundle", "FAIL", e.message.split("\n")[0]); process.exit(1); }
  const BUNDLE = fs.readFileSync(path.join(tmp, "out.js"));
  const LOG = fs.readFileSync(path.join(REPO, "backend", "data", "trade_log.json"), "utf8");
  const BOOK = (() => { const b = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "board_positions.json"), "utf8")); let t = []; try { t = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "board_tombstones.json"), "utf8")); } catch { } const s = new Set(t.map(x => x.id ?? x)); return JSON.stringify({ positions: b.filter(p => p && p.id && !s.has(p.id)), tombstones: [] }); })();
  const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/out.js"></script></body></html>`;

  const browser = await chromium.launch({ headless: true });
  const run = async (scenario) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await ctx.newPage();
    const posts = [], errors = [], dialogs = [];
    page.on("pageerror", e => errors.push(String(e.message || e).slice(0, 200)));
    page.on("dialog", d => { dialogs.push(d.message().slice(0, 120)); d.dismiss().catch(() => {}); });
    try { await page.routeWebSocket(/.*/, ws => ws.close()); } catch { }
    await page.route("**/*", async (route) => {
      const req = route.request(), u = new URL(req.url()), m = req.method();
      if (u.host !== "traids.test") return route.abort();
      if (m !== "GET") { let body = {}; try { body = JSON.parse(req.postData() || "{}"); } catch { } posts.push({ path: u.pathname, replace: !!body.replace, n: Array.isArray(body.log) ? body.log.length : undefined }); return route.fulfill({ status: 200, contentType: "application/json", body: "{\"ok\":true}" }); }
      if (u.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: HTML });
      if (u.pathname === "/out.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: BUNDLE });
      if (u.pathname === "/api/tradelog") return scenario === "down" ? route.fulfill({ status: 503, body: "down" }) : route.fulfill({ status: 200, contentType: "application/json", body: `{"log":${LOG}}` });
      if (u.pathname === "/api/board-positions") return route.fulfill({ status: 200, contentType: "application/json", body: BOOK });
      if (u.pathname === "/api/equities/snapshot" || u.pathname === "/api/option-quotes") {
        if (!QUOTES) return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        try { const r = await fetch(`http://localhost:3001${u.pathname}${u.search}`, { signal: AbortSignal.timeout(30000) }); return route.fulfill({ status: r.status, contentType: "application/json", body: await r.text() }); }
        catch { return route.fulfill({ status: 502, body: "{}" }); }
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });
    if (scenario === "down") await page.addInitScript((rows) => { try { localStorage.setItem("traids_trade_log", rows); } catch { } },
      JSON.stringify(JSON.parse(LOG).sort((a, b) => b.closedAt - a.closedAt).slice(0, 1000)));   // 1,000 not 3,000: 3,000 rows are ~5.5M chars, past Chrome's localStorage quota
    await page.goto("http://traids.test/", { waitUntil: "domcontentloaded" });
    const out = { scenario, posts, errors, dialogs };
    await page.getByText("Daily Board", { exact: true }).first().click();
    await page.getByText("Forward paper record").first().waitFor({ timeout: 30000 });
    await page.waitForFunction(() => !document.body.innerText.includes("loading the full server ledger"), null, { timeout: 60000 }).catch(() => {});
    out.hero = await page.getByText("Forward paper record").first().locator("xpath=..").innerText();
    out.tradeLog = await page.getByText(/^TRADE LOG \(/).first().locator("xpath=..").innerText().catch(() => "(no TRADE LOG panel)");
    await page.getByTitle(/Clearing the trade log is DISABLED/).first().click().catch(e => out.clearErr = e.message);
    await page.waitForTimeout(500);
    if (scenario === "server") {
      await page.getByText("Analytics", { exact: true }).first().click();
      await page.getByText("PORTFOLIO ANALYTICS").first().waitFor({ timeout: 30000 });
      await page.waitForFunction(() => document.body.innerText.includes("open book: server store"), null, { timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(QUOTES ? 8000 : 1500);
      out.analyticsHead = await page.getByText("PORTFOLIO ANALYTICS").first().locator("xpath=..").innerText();
      out.openPnl = await page.getByText(/^Open P&L/).first().locator("xpath=..").innerText();
      out.rows = await page.locator("table tbody tr").count();
      out.zeroCells = await page.locator("table tbody tr td:nth-child(6)").evaluateAll(tds => tds.filter(td => td.innerText.trim() === "$0.00").length);
      await page.getByText("Backtester", { exact: true }).first().click();
      await page.waitForTimeout(1500);
      out.backtester = (await page.locator("body").innerText()).includes("Monte Carlo") ? "rendered" : "no Monte Carlo mode text";
    }
    await ctx.close();
    return out;
  };

  let A, B;
  try { A = await run("server"); B = await run("down"); }
  catch (e) { verdict("render", "UNKNOWN", e.message.split("\n")[0]); await browser.close(); process.exit(2); }
  await browser.close();
  for (const o of [A, B]) {
    console.log(`\n── scenario: ${o.scenario === "server" ? "server ledger answers" : "server ledger DOWN (503), a 1,000-row browser copy present"} ──`);
    console.log("hero:", o.hero.replace(/\s+/g, " "));
    console.log("trade log:", o.tradeLog.replace(/\s+/g, " ").slice(0, 400));
    if (o.analyticsHead) { console.log("analytics:", o.analyticsHead.replace(/\s+/g, " ")); console.log("open P&L card:", o.openPnl.replace(/\s+/g, " "), `· ${o.rows} table rows · ${o.zeroCells} '$0.00' P&L cells`); console.log("backtester:", o.backtester); }
    console.log("dialogs:", JSON.stringify(o.dialogs)); console.log("POSTs (answered locally, never forwarded):", JSON.stringify(o.posts));
    if (o.errors.length) console.log("page errors:", JSON.stringify(o.errors));
  }
  verdict("no uncaught page errors", A.errors.length + B.errors.length === 0 ? "PASS" : "FAIL", [...A.errors, ...B.errors].join(" | ").slice(0, 300));
  verdict("hero reads the full server ledger (since 07-20, row count named)", /since 07-20/.test(A.hero) && /full server ledger/.test(A.hero) ? "PASS" : "FAIL");
  verdict("server down → hero labelled BROWSER COPY with its real window", /BROWSER COPY/.test(B.hero) && !/since 07-20/.test(B.hero) ? "PASS" : "FAIL");
  verdict("'clear' explains and sends no replace:true", [...A.posts, ...B.posts].every(p => !p.replace) && A.dialogs.some(d => /DISABLED/.test(d)) ? "PASS" : "FAIL");
  verdict("analytics: controls excluded, source named", /open controls\/shadows excluded/.test(A.analyticsHead || "") && /server store/.test(A.analyticsHead || "") ? "PASS" : "FAIL");
  verdict("analytics: no '$0.00' P&L fill", A.zeroCells === 0 ? "PASS" : "FAIL", `${A.zeroCells} cells`);
  verdict("backtester renders", A.backtester === "rendered" ? "PASS" : "FAIL");
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }
  const worst = results.includes("FAIL") ? 1 : results.includes("UNKNOWN") ? 2 : 0;
  console.log(`\nverdict: ${["PASS", "FAIL", "UNKNOWN"][worst]}`); process.exit(worst);
})().catch(e => { console.error("[UNKNOWN] smoke crashed:", e.message); process.exit(2); });
