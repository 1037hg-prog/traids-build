/**
 * R151 read — the ONE registered read of the RSI-2 forward test, from BROKER fills (data/r151-ledger.jsonl). Readable after the close
 * of 2026-10-07 (the 10th session from 2026-09-24; amended 2026-09-23 on the operator's word); refuses if already sealed.
 *   primary    arm A (close): mean per-trade return, t across ENTRY SESSIONS (session-clustered), against the registered bar
 *   secondary  A - B on signals both arms traded (same symbol, same signal date); C's fill rate and mean; B and C alone
 * AMENDED 2026-09-23 (pre-evidence, nightly audit finding): lots still OPEN at the read are no longer dropped. RSI-2 exits only when the
 * close recovers above SMA5, so the lots open at a fixed read date are the dips that have not recovered — dropping them selects on
 * outcome (the same defect fixed in R149/R152 the same day). Every open lot with a broker entry fill is MARKED at the 2026-10-07
 * official close (SIP daily bar, adjustment raw) and counted as a trade with markedAtEnd: true.
 * PAPER-AUCTION-FIX 2026-10-02: R151 is FROZEN execution-void by the operator's decision of 2026-10-02 (Alpaca paper barely fills the
 * opg/cls orders it was built on; 1 completed trade in 7 sessions). The freeze is the constant FROZEN_BY_OPERATOR below, independent of
 * the registry edit: this reader prints it and exits 0 without reading or sealing. The successor R311 (same rule, day orders) is read by
 * backend/r311-read.js.
 */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const { fetchBars } = require("./lib/alpaca-bars.js");
const D = (f) => path.join(__dirname, "data", f), READ_DATE = "2026-10-07";
(async () => {
  const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests.R151) { console.log("R151 already sealed — the arms continue as a weightless record"); process.exit(process.argv.includes("--seal") ? 0 : 2); }
  const FROZEN_BY_OPERATOR = "2026-10-02";   // PAPER-AUCTION-FIX 2026-10-02: execution-void, operator 'yes' — independent of the registry edit
  if (FROZEN_BY_OPERATOR) { console.log(`R151 FROZEN ${FROZEN_BY_OPERATOR} — execution-void; never read, nothing sealed; successor R311 reads via backend/r311-read.js (PAPER-AUCTION-FIX 2026-10-02)`); process.exit(0); }   // PAPER-AUCTION-FIX 2026-10-02
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R151");
  const rows = (() => { try { return fs.readFileSync(D("r151-ledger.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
  const closed = rows.filter((r) => r.kind === "trade"), mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const et = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value])), etDate = `${et.year}-${et.month}-${et.day}`;
  if (etDate < READ_DATE || (etDate === READ_DATE && +et.hour % 24 < 17)) { console.log(`R151 not readable yet — reads after the close of ${READ_DATE} (arm A has ${closed.filter((r) => r.arm === "A").length} closed trades so far)`); process.exit(0); }
  if (fs.existsSync(D("r151-read.json")) && JSON.parse(fs.readFileSync(D("r151-read.json"), "utf8")).read) { console.error("R151 already read — seal it"); process.exit(2); }
  // open lots at the read: marked at the READ_DATE official close (entries up to and including READ_DATE)
  const st = (() => { try { return JSON.parse(fs.readFileSync(D("r151-state.json"), "utf8")); } catch { return { lots: [] }; } })();
  const openLots = (st.lots || []).filter((l) => (l.status === "open" || l.status === "exiting") && l.entryFill > 0 && (l.entryFilledAt || "").slice(0, 10) <= READ_DATE);
  let marked = [];
  if (openLots.length) {
    const { bars } = await fetchBars([...new Set(openLots.map((l) => l.sym))], { start: READ_DATE, end: `${READ_DATE}T23:59:59Z`, feed: "sip", adjustment: "raw", quiet: true, requireAll: true });
    marked = openLots.map((l) => { const b = (bars[l.sym] || []).find((x) => x.t.slice(0, 10) === READ_DATE); if (!b) throw new Error(`no ${READ_DATE} close for open lot ${l.sym} — refusing to read without it`);
      return { kind: "trade", markedAtEnd: true, arm: l.arm, sym: l.sym, qty: l.qty, signalDate: l.signalDate, entryDate: (l.entryFilledAt || "").slice(0, 10), exitDate: READ_DATE, entryFill: l.entryFill, exitFill: b.c, ret: +(b.c / l.entryFill - 1).toFixed(6) }; });
  }
  const tr = [...closed, ...marked];
  const tOf = (a) => { const n = a.length; if (n < 3) return null; const m = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)); return sd > 0 ? m / (sd / Math.sqrt(n)) : null; };
  const bySession = (list) => { const m = new Map(); for (const r of list) (m.get(r.entryDate) || m.set(r.entryDate, []).get(r.entryDate)).push(r.ret); return [...m.values()].map(mean); };
  const arm = (a) => { const l = tr.filter((r) => r.arm === a), s = bySession(l), tt = tOf(s); return { trades: l.length, markedAtEnd: l.filter((r) => r.markedAtEnd).length, sessions: s.length, meanRet: l.length ? mean(l.map((r) => r.ret)) : null, meanRetPct: l.length ? +(100 * mean(l.map((r) => r.ret))).toFixed(4) : null, tSessionsRaw: tt, tSessions: tt == null ? null : +tt.toFixed(3), winPct: l.length ? +(100 * l.filter((r) => r.ret > 0).length / l.length).toFixed(1) : null }; };
  const A = arm("A"), key = (r) => r.sym + "|" + r.signalDate, bIdx = new Map(tr.filter((r) => r.arm === "B").map((r) => [key(r), r]));
  const pairs = tr.filter((r) => r.arm === "A" && bIdx.has(key(r))).map((r) => r.ret - bIdx.get(key(r)).ret), pt = tOf(pairs);
  const cTried = rows.filter((r) => r.arm === "C" && (r.kind === "trade" || r.kind === "unfilled-entry")).length + marked.filter((r) => r.arm === "C").length;
  const out = { spec: "r151-read-v2 (open lots marked at the read close)", read: true, asOf: new Date().toISOString(), bar: t.bar.tRequired, A, B: arm("B"), C: { ...arm("C"), fillRatePct: cTried ? +(100 * tr.filter((r) => r.arm === "C").length / cTried).toFixed(1) : null },
    closeMinusOpen: { pairs: pairs.length, meanDiffPct: pairs.length ? +(100 * mean(pairs)).toFixed(4) : null, t: pt == null ? null : +pt.toFixed(3) }, rejects: rows.filter((r) => r.kind === "order-rejected").length, markedAtEnd: marked };
  out.verdict = A.meanRet > 0 && A.tSessionsRaw != null && A.tSessionsRaw >= t.bar.tRequired ? "PASS" : "DID NOT PASS";   // unrounded comparison
  writeJsonAtomic(D("r151-read.json"), out); console.log(JSON.stringify({ ...out, markedAtEnd: marked.length }, null, 1));
  if (process.argv.includes("--seal")) require("./seal-r151.js");
})().catch((e) => { console.error("R151 read FAILED:", e.message); process.exit(1); });
