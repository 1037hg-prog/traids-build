/**
 * TRAIDS — headless Track / Settle automation.
 *   node automation/auto.mjs track     (morning, ~7:15 AM MT / just before the 9:30 ET open)
 *   node automation/auto.mjs settle    (afternoon, after 2:00 PM MT / the 4 PM ET close)
 *
 * Drives the SAME board UI you click by hand, so results match exactly.
 * A persistent Chrome profile keeps the morning's tracked positions for the afternoon settle.
 * Logs every run to automation/auto.log. Requires the three servers to be running (start.bat).
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTION = (process.argv[2] || "").toLowerCase();           // track | settle
const PORT = 9444;
const PROFILE = path.join(__dirname, ".chrome-profile");
const LOG = path.join(__dirname, "auto.log");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => { const line = `${new Date().toISOString()}  [${ACTION}]  ${m}`; console.log(line); try { fs.appendFileSync(LOG, line + "\n"); } catch {} };

if (!["track", "settle"].includes(ACTION)) { console.error("usage: node auto.mjs track|settle"); process.exit(2); }

let chrome;
async function main() {
  // sanity: is the app up?
  try { const r = await fetch("http://localhost:3000/"); if (!r.ok) throw 0; }
  catch { log("ERROR: app not reachable on :3000 — are the servers running (start.bat)?"); process.exit(1); }

  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--window-size=1500,1200",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check",
    "http://localhost:3000/"], { stdio: "ignore" });

  // find the page websocket
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    try { const l = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
      const p = l.find(t => t.type === "page" && t.url.includes("localhost:3000"));
      if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {}
    await sleep(400);
  }
  if (!wsUrl) { log("ERROR: could not attach to headless Chrome"); cleanup(1); return; }

  const ws = new WebSocket(wsUrl); let id = 0; const pend = new Map();
  ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value;
  await new Promise(r => ws.addEventListener("open", r));
  await send("Runtime.enable");

  // wait for the board scan to finish (or a sit-out)
  for (let i = 0; i < 180; i++) { const t = await ev("document.body.textContent");
    if (typeof t === "string" && (/scanned\s+\d+\/\d+/i.test(t) || /sit it out|No high-confidence setups today/i.test(t))) break;
    await sleep(1000); }
  await sleep(2500);

  if (ACTION === "track") {
    const before = await ev("JSON.parse(localStorage.getItem('traids_positions')||'[]').length");
    const r = await ev("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Track ALL'));if(b){b.click();return 'ok';}return 'no-button';})()");
    await sleep(2000);
    const after = await ev("JSON.parse(localStorage.getItem('traids_positions')||'[]').length");
    log(`Track ALL → ${r}; positions ${before} → ${after}`);
  } else {
    const open = await ev("JSON.parse(localStorage.getItem('traids_positions')||'[]').length");
    if (!open) { log("nothing to settle (0 tracked positions — was Track ALL run this morning, same profile?)"); cleanup(0); return; }
    await ev("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Settle day'));b&&b.click();return 1;})()");
    // settle retries internally up to ~30s; poll until positions clear or 90s
    let logged = 0;
    for (let i = 0; i < 60; i++) { await sleep(2000);
      const pos = await ev("JSON.parse(localStorage.getItem('traids_positions')||'[]').length");
      logged = await ev("JSON.parse(localStorage.getItem('traids_trade_log')||'[]').length");
      if (pos === 0) break; }
    log(`Settle day → ${open} positions settled; trade log now ${logged}`);
  }
  ws.close();
  cleanup(0);
}

function cleanup(code) { try { chrome?.kill(); } catch {} setTimeout(() => process.exit(code), 800); }
main().catch(e => { log("ERROR: " + (e?.message || e)); cleanup(1); });
