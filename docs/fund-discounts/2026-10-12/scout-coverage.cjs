"use strict";
// STEP 2 (coverage): for every fund on the list, does Yahoo's chart endpoint serve the PRICE series and the NAV series, from when,
// how many rows. Endpoint: GET https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1=0&period2=<now>&interval=1d&comparisons=A,B,C,D,E
// The `comparisons` parameter returns up to FIVE other symbols' daily closes aligned to the primary symbol's dates (measured 2026-10-12:
// ten asked, five returned). The primary is the S&P 500 index only because it has a row on every US market day since 1970; no value of
// it is used. That makes ~145 requests for ~725 symbols instead of ~725, which is what keeps this scout under its 300-request fence.
// WHAT IS STORED: one compact file per symbol in the cache folder (market-day index + close), so every later count costs no request.
// WHAT IS PRINTED: symbol counts only. No return, no discount, no outcome is computed here.
const fs = require("fs"), path = require("path");
const { get, CACHE, readCount, day } = require("./scout-lib.cjs");
const SER = path.join(CACHE, "series"); fs.mkdirSync(SER, { recursive: true });
const PROG = path.join(CACHE, "coverage-progress.json");
const slim = JSON.parse(fs.readFileSync(path.join(CACHE, "cefconnect-universe-slim.json"), "utf8"));
const prog = fs.existsSync(PROG) ? JSON.parse(fs.readFileSync(PROG, "utf8")) : { asked: {}, batches: [] };
const saveProg = () => fs.writeFileSync(PROG, JSON.stringify(prog));
const shaped = (s) => /^X[A-Z]{2,4}X$/.test(s || "");

// candidate symbols: every price ticker; the list's own NAV symbol; and the X+ticker+X guess where the list gives none or an odd one.
function candidates(pass) {
  const out = [];
  for (const r of slim) {
    const guess = "X" + r.Ticker + "X", listed = r.NavTicker && r.NavTicker !== r.Ticker ? r.NavTicker : null;
    if (pass === 1) { out.push(r.Ticker); if (listed) out.push(listed); if (!listed || !shaped(listed)) out.push(guess); }
    else if (pass === 2) { // fallback: the guess, for funds whose listed NAV symbol returned nothing in pass 1
      if (listed && listed !== guess && prog.asked[listed] === "none" && !prog.asked[guess]) out.push(guess);
    }
  }
  return [...new Set(out)].filter((s) => !prog.asked[s]);
}

(async () => {
  const pass = Number(process.argv[2] || 1), maxBatches = Number(process.argv[3] || 1e9);
  const todo = candidates(pass);
  console.log(`pass ${pass}: ${todo.length} symbols to ask, ${Math.ceil(todo.length / 5)} requests; cap state ${JSON.stringify(readCount())}`);
  let calendarWritten = fs.existsSync(path.join(CACHE, "calendar.json")), done = 0;
  for (let i = 0; i < todo.length && done < maxBatches; i += 5, done++) {
    const batch = todo.slice(i, i + 5), now = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1=0&period2=${now}&interval=1d&comparisons=${encodeURIComponent(batch.join(","))}`;
    let r; try { r = await get(url, { timeoutMs: 90000 }); } catch (e) { prog.batches.push({ batch, error: String(e.message).slice(0, 120) }); saveProg(); console.log("  batch error:", batch.join(","), e.message); if (/request cap/.test(e.message)) break; continue; }
    if (r.status !== 200) { prog.batches.push({ batch, status: r.status, body: r.text.slice(0, 160) }); saveProg(); console.log("  HTTP", r.status, batch.join(","), r.text.slice(0, 120).replace(/\s+/g, " ")); continue; }
    let res; try { res = JSON.parse(r.text).chart.result[0]; } catch (e) { prog.batches.push({ batch, error: "unparseable" }); saveProg(); continue; }
    const ts = res.timestamp || [];
    if (!calendarWritten || pass === 1) { fs.writeFileSync(path.join(CACHE, "calendar.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), days: ts.map(day) })); calendarWritten = true; }
    const got = new Map((res.comparisons || []).map((c) => [String(c.symbol).toUpperCase(), c]));
    for (const s of batch) {
      const c = got.get(s.toUpperCase());
      if (!c) { prog.asked[s] = "none"; continue; }
      const idx = [], close = []; const cl = c.close || [];
      for (let k = 0; k < cl.length; k++) if (cl[k] != null) { idx.push(k); close.push(cl[k]); }
      if (!idx.length) { prog.asked[s] = "none"; continue; }
      fs.writeFileSync(path.join(SER, s + ".json"), JSON.stringify({ symbol: s, calendarLength: ts.length, fetchedAt: new Date().toISOString(), idx, close }));
      prog.asked[s] = "ok";
    }
    prog.batches.push({ batch, status: 200, returned: got.size, calendar: ts.length }); saveProg();
    if (done % 10 === 0) console.log(`  ${done + 1} requests done; last batch ${batch.join(",")} returned ${got.size}`);
  }
  const v = Object.values(prog.asked);
  console.log(`asked so far ${v.length}: ok ${v.filter((x) => x === "ok").length}, none ${v.filter((x) => x === "none").length}; failed batches ${prog.batches.filter((b) => b.status !== 200).length}; requests ${JSON.stringify(readCount())}`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
