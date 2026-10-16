/**
 * SEAT CLAIMS GRADER — evening one of the build (operator, 2026-09-15: "the claims grader has to be built ... start with 1").
 *
 * WHAT. Every seat in the seat wave seals one claim a session (data/seat-claims.jsonl, hash-chained, never edited): seat, kind,
 * subject, magnitude, direction, window {opensAt, closesAt}, falsifier. Until tonight nothing graded them. This file resolves each
 * claim whose window has closed against the SOURCE the falsifier names — the canonical ledger, the agent book, the R54 twin store,
 * the portfolio-risk snapshots, consolidated daily bars — and writes one grade row per claim to data/seat-grades.jsonl
 * (append-only, keyed by seq; a claim is graded once) and a per-seat record to data/seat-grades.json.
 *
 * RESOLVERS, one per claim kind (four shapes cover six seats):
 *   news         (news-trader)          subject names a symbol and a direction for the next session -> that session's consolidated
 *                                       close vs the prior close. HELD if the close moved the claimed way.
 *   would-do     (head-trader)          every head-trader falsifier names the registered HT1 statistic, so the claim is read from the
 *                                       registered reader's own output (data/ht1-grade.json rows, memo-day = claim session, forSession =
 *                                       window close): GRADED -> HELD if D_d > 0, FAILED if <= 0. HT1 VOID -> FAILED only when the sealed
 *                                       falsifier itself says "or VOID(s)"; otherwise UNRESOLVED. HT1 not yet run for the day -> PENDING.
 *                                       A would-do whose falsifier does not name HT1 -> UNRESOLVED (hand read). Never the ticket's P&L.
 *   allocation   (portfolio-manager)    agent-book tickets are read from agent-book-ledger.jsonl (lib/agent-book.js readLedger; the
 *                                       book's own agent-book.json keeps only a closed COUNT). Falsifier shapes: "settles at worse than
 *                                       -xR ... OR <cluster unwinds>" -> FAILED if the ticket settled inside the window below -xR; if not,
 *                                       the second limb is not machine-readable -> UNRESOLVED. "combined ...-linked book shows GREATER
 *                                       absolute R-loss on an ...-adverse day" -> a counterfactual cluster read with no per-session mark
 *                                       source here -> UNRESOLVED (hand read). Anything else -> UNRESOLVED.
 *   exit         (stop-manager)         subject names a ticket -> the R54 twin's d (twin R minus live R). HELD if d > 0 once resolved,
 *                                       PENDING while the twin is unresolved. A ticket with no R54 twin is outside R54's population ->
 *                                       UNRESOLVED; never the ticket's own P&L.
 *   halt         (risk-governor)        the sealed FALSIFIER's own condition, parsed into atoms and evaluated three-valued:
 *                                       realized (realizedToday of the session's last post-16:00 ET portfolio-risk.jsonl snapshot when
 *                                       the falsifier names realizedToday or dailyLossHaltDollars; when it only says "realized/session
 *                                       P&L", both that and the canonical ledger must agree or the atom is unknown), worst-case-open (same
 *                                       close snapshot), and "no circuit-breaker WOULD-HALT event" (data/circuit-breaker.json). Joined by
 *                                       the falsifier's own AND/OR/while; "through the session"/"all session"/"cluster loss" are unknown
 *                                       conjuncts. Falsified -> FAILED, not falsified -> HELD, unknown -> UNRESOLVED. The seat's magnitude
 *                                       (its exposure OVERAGE above the ceiling) is never read as a loss threshold. A falsifier naming a
 *                                       session other than the window close, or carrying a garbled figure, -> UNRESOLVED.
 *                                       2026-09-24 (weekly audit 2026-09-23, agents lens; operator-approved): these four paths replaced
 *                                       grading on raw ticket P&L, an unreadable agent-book field, and magnitude-as-loss-threshold.
 *   construction (portfolio-constructor) realized dollars per worst-case-open dollar, mean over the window's sessions vs the mean
 *                                       of the 5 sessions before it (portfolio-risk.jsonl + ledger). HELD if the window ratio is
 *                                       higher (the cap raised risk-adjusted return, as the seat claimed).
 *   exposure / measurement (one-offs)   UNRESOLVED — listed for a hand read.
 *
 * A grade is HELD, FAILED or UNRESOLVED (source missing, ticket still open, shape not machine-readable); PENDING while the window is
 * open. Nothing here changes a claim, a seat's authority or a trade. Weights come in evening two, on top of this record.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const D = (f) => path.join(__dirname, "data", f);
const CLAIMS = D("seat-claims.jsonl"), GRADES = D("seat-grades.jsonl"), OUT = D("seat-grades.json");
const API = process.env.TRAIDS_API || "http://localhost:3001";
const dry = process.argv.includes("--dry");
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const etHM = () => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
const today = etDay(Date.now());
const sessionClosed = (d) => d < today || (d === today && etHM() >= "16:10");
const rl = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const num = (v) => (Number.isFinite(v) ? v : null);
const TICKET_ID = /\b(\d{13}-[A-Za-z]+-[A-Z0-9./]+-[a-z0-9]{4})\b/;
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(4));

// --regrade 3,9 : append a SUPERSEDING grade row for those seqs (the ledger stays append-only; the latest row per seq is the grade).
const REGRADE = new Set(((process.argv[process.argv.indexOf("--regrade") + 1] || "").match(/\d+/g) || []).map(Number));
const claims = rl(CLAIMS), gradedAll = rl(GRADES);
// 2026-10-01 audit (agents#1): a VOID row ({ seq, void: true, voids, why }) withdraws every earlier grade row for its seq WITHOUT deleting
// it (the ledger stays append-only); the seq is then re-resolved under the current resolvers and the fresh row says it supersedes a void.
// Written for the 32 pre-2026-09-24 grades made by the resolvers the operator-approved 09-24 fix retired (operator 2026-10-01: "throw out
// those results"). A void row is never a grade: it is not counted, and it is never the grade of record.
const latest = new Map(), VOIDED = new Set(); for (const g of gradedAll) { if (g.void === true) { latest.delete(g.seq); VOIDED.add(g.seq); } else { latest.set(g.seq, g); VOIDED.delete(g.seq); } }   // file order = time order; last wins
const graded = [...latest.values()].filter((g) => !REGRADE.has(g.seq)); const done = new Set(graded.map((g) => g.seq));
const RC = require("./lib/reconcile.js"); const L = RC.cleanEraLedger();
// 2026-09-24 (audit A0923 agents lens): settled agent-book rows live in agent-book-ledger.jsonl — agent-book.json's `closed` is a COUNT,
// so the old read of agentBook.closed/settled was always empty and every allocation claim graded UNRESOLVED "not settled yet".
const abClosed = new Map(require("./lib/agent-book.js").readLedger().filter((t) => t && t.id && Number.isFinite(t.closedAt)).map((t) => [t.id, t]));
const r54 = (() => { try { return JSON.parse(fs.readFileSync(D("r54-stop-twin.json"), "utf8")); } catch { return null; } })();
const twinById = new Map(((r54 && r54.twins) || []).map((t) => [t.id, t]));
const ht1 = (() => { try { return JSON.parse(fs.readFileSync(D("ht1-grade.json"), "utf8")); } catch { return null; } })();   // the registered HT1 reader's output
const cbEvents = (() => { try { const j = JSON.parse(fs.readFileSync(D("circuit-breaker.json"), "utf8")); return Array.isArray(j.events) ? j.events : null; } catch { return null; } })();
const etTime = (ms) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour12: false });
// the session's CLOSE snapshot: the last portfolio-risk.jsonl row for that ET date stamped at/after 16:00 ET (rows are appended hourly+)
const closeSnap = (() => { const m = {}; for (const r of rl(D("portfolio-risk.jsonl"))) if (r.date && r.at && etTime(Date.parse(r.at)) >= "16:00:00") m[r.date] = r; return (d) => m[d] || null; })();
const realizedOn = (d) => (L.signals || []).filter((t) => Number.isFinite(t.pnl) && Number.isFinite(t.closedAt) && etDay(t.closedAt) === d).reduce((a, t) => a + t.pnl, 0);
const riskSnaps = (() => { const m = {}; for (const r of rl(D("portfolio-risk.jsonl"))) if (r.date && Number.isFinite(r.worstCaseOpen)) m[r.date] = r; return m; })();
const sessionsBetween = (a, b) => Object.keys(riskSnaps).filter((d) => d > a && d <= b).sort();

async function dailyCloses(sym, lim = 12) {
  const r = await fetch(`${API}/api/chart/bars?symbol=${encodeURIComponent(sym)}&cls=Equity&tf=1d&limit=${lim}`, { signal: AbortSignal.timeout(15000) }).then((x) => x.json()).catch(() => null);
  const bars = (r && r.bars) || []; const m = {}; for (const b of bars) m[etDay(b.t)] = b.c; return m;
}
const windowClose = (c) => String((c.window || {}).closesAt || "").slice(0, 10);
const grade = (c, verdict, number, method, note) => ({ seq: c.seq, seat: c.seat, kind: c.kind, session: c.session, windowClosed: windowClose(c), verdict, number: r4(number), method, note: note || null, gradedAt: new Date().toISOString(), ...(REGRADE.has(c.seq) ? { supersedes: true, why: "regrade after a grader fix; the earlier row stays in the ledger" } : VOIDED.has(c.seq) ? { supersedes: true, why: "re-resolved under the current resolvers after the earlier grade row(s) were voided (see the void row); they stay in the ledger" } : {}) });

/**
 * HALT FALSIFIER PARSER (2026-09-24). Reads the condition the risk-governor SEALED, not a threshold the grader chose. Returns
 * { atoms: [{ key, op, value }], conn: "AND"|"OR", unknowns: [..], problem } — problem set => the falsifier is not machine-readable.
 * Parenthetical asides are dropped (they restate numbers, e.g. "(<=-2000)"), and the explanatory tail after " -- " or "i.e." is cut
 * (it describes the sealing night: "despite ... at tonight's close"). Everything left must parse, or the claim is UNRESOLVED.
 */
const OPS = "at or above|at or below|at or better than|at or worse than|at\\/above|at\\/below|>=|<=";
const NUM = "[+-]?\\s*\\$?\\s*\\d[\\d,]*(?:\\.\\d+)?";
const opOf = (s) => (/above|better|>=/.test(s) ? ">=" : "<=");
const numOf = (s) => { const t = String(s).replace(/[\s$,]/g, ""); const digits = t.replace(/^[+-]/, "").split(".")[0]; return /^0\d/.test(digits) ? NaN : Number(t); };   // "-00" (a shell-eaten "$2000") is garbled, not zero
function parseHaltFalsifier(fals) {
  let t = String(fals); for (let i = 0; i < 3; i++) t = t.replace(/\([^()]*\)/g, " ");
  t = t.split(/\s--\s|\bi\.e\./)[0];
  const find = (key, re) => { const all = [...t.matchAll(new RegExp(re, "gi"))]; return all.map((m) => ({ key, op: opOf(m[2].toLowerCase()), value: numOf(m[3]), raw: m[0], at: m.index, end: m.index + m[0].length })); };
  const rz = find("realized", `\\b(realized P&L|realizedToday|session P&L|session realized P&L)\\b[^;]*?(${OPS})\\s*(?:the\\s+)?(${NUM})`);
  const wc = find("worstCaseOpen", `\\b(worst-?case-?open|worstCaseOpen)\\b[^;]*?(${OPS})\\s*(?:the\\s+)?(${NUM})`);
  if (rz.length > 1 || wc.length > 1) return { problem: "more than one realized or worst-case-open condition" };
  const atoms = [...rz, ...wc].sort((a, b) => a.at - b.at);
  if (!atoms.length) return { problem: "no realized or worst-case-open condition found" };
  if (atoms.some((a) => !Number.isFinite(a.value))) return { problem: `garbled figure in "${atoms.find((a) => !Number.isFinite(a.value)).raw.trim()}"` };
  let conn = "AND";
  if (atoms.length === 2) { const mid = t.slice(atoms[0].end, atoms[1].at); const or = /\bor\b/i.test(mid), and = /\band\b|\bwhile\b/i.test(mid);
    if (or === and) return { problem: `cannot tell AND from OR between the two conditions ("${mid.trim()}")` }; conn = or ? "OR" : "AND"; }
  const unknowns = [];
  if (/\bno circuit-breaker\b/i.test(t)) atoms.push({ key: "noBreakerEvent", op: "==", value: true, raw: "no circuit-breaker HALT/WOULD-HALT event that session" });
  if (/through the session|all session|intraday/i.test(t)) unknowns.push("a through-the-session condition (only close snapshots are recorded)");
  if (/cluster loss/i.test(t)) unknowns.push("a cluster-loss condition");
  if (atoms.some((a) => a.key === "noBreakerEvent") && conn === "OR") return { problem: "a circuit-breaker condition inside an OR" };
  if (unknowns.length && conn === "OR") return { problem: "an unreadable condition inside an OR" };
  return { atoms, conn, unknowns };
}
const tri = (conn, vals) => (conn === "OR" ? (vals.includes(true) ? true : vals.every((v) => v === false) ? false : null) : (vals.includes(false) ? false : vals.every((v) => v === true) ? true : null));
const cmp = (x, op, v) => (x == null ? null : op === ">=" ? x >= v : x <= v);

async function resolve(c) {
  const wc = windowClose(c); const subj = String(c.subject || ""), fals = String(c.falsifier || ""), dir = String(c.direction || "").toLowerCase();
  if (!wc || !sessionClosed(wc)) return null;   // PENDING
  switch (c.kind) {
    case "news": {
      const sym = (subj.match(/^([A-Z][A-Z0-9.]{0,5})\b/) || [])[1]; if (!sym) return grade(c, "UNRESOLVED", null, "news", "no symbol at the head of the subject");
      const closes = await dailyCloses(sym); const days = Object.keys(closes).sort(); const i = days.indexOf(wc);
      if (i < 1) return grade(c, "UNRESOLVED", null, "news", `no consolidated close for ${sym} on ${wc}`);
      const move = closes[days[i]] / closes[days[i - 1]] - 1; const held = dir === "short" ? move < 0 : dir === "long" ? move > 0 : null;
      if (held == null) return grade(c, "UNRESOLVED", move, "news", "direction is neither long nor short");
      return grade(c, held ? "HELD" : "FAILED", move * 100, "news: next-session close vs prior close (%)", `${sym} ${dir} ${wc}`);
    }
    case "would-do": {
      // 2026-09-24 (audit A0923 agents lens): graded on the registered HT1 statistic every head-trader falsifier names, read from the
      // registered reader's own output — never the named ticket's raw P&L (which scored #32/#50 FAILED where HT1 D_d was positive).
      if (!/\bHT1\b/.test(fals)) return grade(c, "UNRESOLVED", null, "would-do", "UNGRADED — the falsifier names no HT1 statistic; this grader reads no other would-do statistic (hand read)");
      if (!ht1 || !Array.isArray(ht1.rows)) return null;   // registered reader output unreadable -> PENDING, never a substitute
      const row = ht1.rows.find((r) => r.session === c.session);
      if (!row) return ht1.asOf && etDay(Date.parse(ht1.asOf)) > wc ? grade(c, "UNRESOLVED", null, "would-do: HT1", `UNGRADED — HT1 (asOf ${ht1.asOf}) has no memo-day row for session ${c.session}`) : null;
      if (row.forSession && row.forSession !== wc) return grade(c, "UNRESOLVED", null, "would-do: HT1", `UNGRADED — HT1 memo-day ${row.session} grades forSession ${row.forSession}, the claim window closes ${wc}`);
      const st = String(row.status || "");
      if (/^PENDING/.test(st)) return null;
      if (/^GRADED/.test(st) && Number.isFinite(row.D_d)) return grade(c, row.D_d > 0 ? "HELD" : "FAILED", row.D_d, "would-do: HT1 D_d = A_d - B_d (registered reader, data/ht1-grade.json)", `memo-day ${row.session} -> ${row.forSession}; A_d ${row.A_d}, B_d ${row.B_d}, nAllSettled ${row.nAllSettled}`);
      if (/^VOID/.test(st)) { const voidFalsifies = /\bor\s+(?:the memo-day is\s+)?VOIDs?\b/i.test(fals);   // e.g. #8 "... or the memo-day is VOID", #44 "... or VOIDs because ..."
        return voidFalsifies ? grade(c, "FAILED", null, "would-do: HT1 VOID, which the sealed falsifier names as a falsification", st) : grade(c, "UNRESOLVED", null, "would-do: HT1", `UNGRADED — HT1 ${st} (the falsifier does not name VOID as a failure)`); }
      return grade(c, "UNRESOLVED", null, "would-do: HT1", `UNGRADED — unreadable HT1 row status "${st}"`);
    }
    case "exit": {
      // 2026-09-24 (audit A0923 agents lens): the stop-manager's falsifier is R54's twin d. A ticket with no R54 twin is outside R54's
      // population and is UNGRADED — it is never graded on the ticket's own P&L (the old fallback scored #12/#18/#24 on ticket dollars).
      const id = (subj.match(TICKET_ID) || [])[1];
      if (!id) return grade(c, "UNRESOLVED", null, "exit: R54 twin", "UNGRADED — no complete ticket id in the subject");
      if (!r54) return null;   // the R54 store is unreadable -> PENDING, never a substitute
      const t = twinById.get(id);
      if (!t) return grade(c, "UNRESOLVED", null, "exit: R54 twin", `UNGRADED — ticket ${id} is outside the R54 population (no twin in r54-stop-twin.json); not graded on ticket P&L`);
      if (!t.resolved || !Number.isFinite(t.d)) return null;   // twin still open -> PENDING until R54 resolves it
      return grade(c, t.d > 0 ? "HELD" : "FAILED", t.d, "exit: R54 twin d (twin R minus live R)", id);
    }
    case "allocation": {
      // 2026-09-24 (audit A0923 agents lens): graded on the falsifier the portfolio-manager sealed, from agent-book-ledger.jsonl.
      if (/combined[\s\S]*?book[\s\S]*?GREATER absolute R-loss/i.test(fals)) return grade(c, "UNRESOLVED", null, "allocation", "UNGRADED — the falsifier is a counterfactual combined-cluster R-loss on an adverse day; no per-session cluster mark source exists for it here (hand read)");
      const lim = fals.match(/settles at worse than\s*(-\s*\d+(?:\.\d+)?)\s*R\b/i);
      if (!lim) return grade(c, "UNRESOLVED", null, "allocation", "UNGRADED — falsifier shape not machine-readable (hand read)");
      const thr = Number(lim[1].replace(/\s/g, "")), otherLimb = /\bOR\b/.test(fals.slice(lim.index + lim[0].length));
      const id = (fals.match(TICKET_ID) || subj.match(TICKET_ID) || [])[1]; if (!id) return grade(c, "UNRESOLVED", null, "allocation", "UNGRADED — no agent-book ticket id in the falsifier or subject");
      const t = abClosed.get(id); if (!t) return null;   // not settled in agent-book-ledger.jsonl yet -> PENDING
      const rM = num(t.rMult); if (rM == null) return grade(c, "UNRESOLVED", null, "allocation", `UNGRADED — settled row ${id} has no rMult`);
      const inWindow = etDay(t.closedAt) <= wc;   // settled by the window-close session (time-caps settle in that evening's close chain)
      const limbA = inWindow && rM < thr;
      if (limbA) return grade(c, "FAILED", rM, `allocation: agent-book ticket rMult settled worse than ${thr}R inside the window`, id);
      if (otherLimb) return grade(c, "UNRESOLVED", rM, "allocation", `UNGRADED — limb 1 did not fire (rMult ${rM} vs ${thr}R${inWindow ? "" : ", settled after the window"}); limb 2 (cluster unwind before the hedge closed) is not machine-readable (hand read)`);
      return grade(c, "HELD", rM, `allocation: agent-book ticket rMult not worse than ${thr}R inside the window`, id);
    }
    case "halt": {
      // 2026-09-24 (audit A0923 agents lens): the risk-governor is graded on its sealed falsifier. c.magnitude is the worst-case-open
      // OVERAGE above the $20,000 ceiling, never a loss threshold; the first $ figure in the text is never a loss threshold either.
      if (wc === today) return null;   // the session's snapshot series is final only after the day; grade it the next evening
      const named = (fals.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
      if (named && named !== wc) return grade(c, "UNRESOLVED", null, "halt", `UNGRADED — the falsifier names session ${named}, the window closes ${wc}; not substituting one session for another`);
      const P = parseHaltFalsifier(fals); if (P.problem) return grade(c, "UNRESOLVED", null, "halt", `UNGRADED — ${P.problem}`);
      const snap = closeSnap(wc), led = realizedOn(wc), namedRT = /realizedToday|dailyLossHaltDollars/.test(fals);
      const notes = [], vals = [];
      for (const a of P.atoms) {
        let v = null;
        if (a.key === "realized") {
          const rt = snap && Number.isFinite(snap.realizedToday) ? snap.realizedToday : null;
          if (namedRT) { v = cmp(rt, a.op, a.value); notes.push(`realizedToday ${rt ?? "n/a"} ${a.op} ${a.value} -> ${v}`); }
          else { const v1 = cmp(rt, a.op, a.value), v2 = cmp(led, a.op, a.value); v = v1 === v2 ? v1 : null; notes.push(`realized ${a.op} ${a.value}: realizedToday ${rt ?? "n/a"} -> ${v1}, canonical ledger ${r4(led)} -> ${v2}${v1 === v2 ? "" : " (sources disagree)"}`); }
        } else if (a.key === "worstCaseOpen") { const w = snap && Number.isFinite(snap.worstCaseOpen) ? snap.worstCaseOpen : null; v = cmp(w, a.op, a.value); notes.push(`worstCaseOpen ${w ?? "n/a"} ${a.op} ${a.value} -> ${v}`); }
        else if (a.key === "noBreakerEvent") { v = cbEvents ? !cbEvents.some((e) => e && e.at && etDay(Date.parse(e.at)) === wc && /HALT/.test(String(e.type))) : null; notes.push(`no breaker event on ${wc} -> ${v}`); }
        vals.push(v);
      }
      for (const u of P.unknowns) { vals.push(null); notes.push(`${u} -> unknown`); }
      const falsified = tri(P.conn, vals);
      const rA = P.atoms.find((a) => a.key === "realized");
      const lenient = dir === "halt" && rA && rA.op === ">=" && rA.value >= 0 && P.conn === "AND" ? "; LENIENT: no losing session can falsify this halt" : "";
      const note = `${wc} close snapshot ${snap ? snap.at : "missing"}; ${P.conn}: ${notes.join("; ")}${lenient}`;
      const number = rA ? (namedRT ? (snap ? snap.realizedToday : null) : led) : (snap ? snap.worstCaseOpen : null);
      if (falsified == null) return grade(c, "UNRESOLVED", number, "halt: sealed falsifier", "UNGRADED — condition undecidable from the recorded sources; " + note);
      return grade(c, falsified ? "FAILED" : "HELD", number, "halt: sealed falsifier condition (falsified -> FAILED)", note);
    }
    case "construction": {
      const open = String((c.window || {}).opensAt || "").slice(0, 10); const win = sessionsBetween(open, wc); const prior = Object.keys(riskSnaps).filter((d) => d <= open).sort().slice(-5);
      if (win.length < 3 || prior.length < 3) return grade(c, "UNRESOLVED", null, "construction", `window ${win.length} / prior ${prior.length} sessions with snapshots`);
      const ratio = (ds) => ds.reduce((a, d) => a + realizedOn(d) / Math.max(1, riskSnaps[d].worstCaseOpen), 0) / ds.length;
      const rw = ratio(win), rp = ratio(prior); return grade(c, rw > rp ? "HELD" : "FAILED", rw - rp, "construction: realized $ per worst-case-open $, window mean minus prior-5 mean", `${win.length} vs ${prior.length} sessions`);
    }
    default: return grade(c, "UNRESOLVED", null, c.kind, "no resolver for this claim kind (one-off; hand read)");
  }
}

// --hand "seq=HELD|FAILED|number|note" : a one-off claim kind read by a person against its source, appended as a superseding row that says so.
const HAND = new Map(process.argv.filter((a) => /^\d+=(HELD|FAILED)\|/.test(a)).map((a) => { const [seq, rest] = a.split("="); const [verdict, number, ...note] = rest.split("|"); return [Number(seq), { verdict, number: Number(number), note: note.join("|") }]; }));
for (const seq of HAND.keys()) { REGRADE.add(seq); done.delete(seq); }
(async () => {
  const fresh = [], pending = [];
  for (const c of claims) { if (done.has(c.seq)) continue; if (HAND.has(c.seq)) { const h = HAND.get(c.seq); fresh.push({ ...grade(c, h.verdict, h.number, `${c.kind}: HAND READ against the source (operator session 2026-09-15)`, h.note), hand: true }); continue; } const g = await resolve(c); if (!g) pending.push(c.seq); else fresh.push(g); }
  if (!dry && fresh.length) fs.appendFileSync(GRADES, fresh.map((g) => JSON.stringify(g)).join("\n") + "\n");
  const all = [...new Map([...graded, ...fresh].map((g) => [g.seq, g])).values()]; const bySeat = {};   // one grade per seq: the latest row wins
  for (const g of all) { const s = (bySeat[g.seat] ||= { graded: 0, held: 0, failed: 0, unresolved: 0 }); s.graded++; s[g.verdict === "HELD" ? "held" : g.verdict === "FAILED" ? "failed" : "unresolved"]++; }
  for (const c of claims) { const s = (bySeat[c.seat] ||= { graded: 0, held: 0, failed: 0, unresolved: 0 }); s.claims = (s.claims || 0) + 1; }
  for (const s of Object.values(bySeat)) { s.pending = (s.claims || 0) - s.graded; s.record = s.held + s.failed ? `${s.held}-${s.failed}` : "0-0"; s.hitRate = s.held + s.failed ? +(s.held / (s.held + s.failed)).toFixed(3) : null; }
  /**
   * WEIGHTS (evening two, 2026-09-15). Recorded, NOT applied: lib/seat-authority.js still reads seals, not these numbers, and the
   * calendar's mechanical-seats row says a weight is registered before it moves anything. The rule, so it is not re-derived later:
   *   decided = held + failed (UNRESOLVED counts for nothing);
   *   shrunk hit rate = (held + 2) / (decided + 4)  — a Beta(2,2) prior toward a coin flip;
   *   weight = 0 until decided >= 20; then clamp(2 x (shrunk - 0.5), 0, 0.5) — a seat can earn at most half authority from grades alone.
   * Every run appends one row per seat to data/seat-weights.jsonl when the decided count changed, so the path of each weight is kept.
   */
  const MIN_DECIDED = 20, CAP = 0.5, weights = {}, weightRows = [];
  const prevW = (() => { const m = {}; for (const r of rl(D("seat-weights.jsonl"))) m[r.seat] = r; return m; })();
  for (const [seat, s] of Object.entries(bySeat)) {
    const decided = s.held + s.failed, shrunk = +((s.held + 2) / (decided + 4)).toFixed(4);
    const weight = decided >= MIN_DECIDED ? +Math.min(CAP, Math.max(0, 2 * (shrunk - 0.5))).toFixed(3) : 0;
    weights[seat] = { decided, shrunkHitRate: shrunk, weight, gate: decided >= MIN_DECIDED ? "open" : `needs ${MIN_DECIDED - decided} more decided claims` };
    if (!prevW[seat] || prevW[seat].decided !== decided) weightRows.push({ at: new Date().toISOString(), seat, decided, held: s.held, failed: s.failed, shrunkHitRate: shrunk, weight, applied: false });
  }
  if (!dry && weightRows.length) fs.appendFileSync(D("seat-weights.jsonl"), weightRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const voidRows = gradedAll.filter((g) => g.void === true);   // 2026-10-01 audit (agents#1): disclosed beside the record, never counted in it
  const out = { spec: "seat-claims-grader-v1", builtOn: "2026-09-15 (evening one + two)", asOf: new Date().toISOString(), claims: claims.length, graded: all.length, gradedTonight: fresh.length, pending: pending.length, bySeat, weights,
    voided: voidRows.length ? { rows: voidRows.length, seqs: [...new Set(voidRows.map((g) => g.seq))].sort((a, b) => a - b), on: [...new Set(voidRows.map((g) => g.voidedOn))].join(", "), why: voidRows[voidRows.length - 1].why } : null,
    weightRule: `weight = 0 until ${MIN_DECIDED} decided claims; then clamp(2 x (shrunkHitRate - 0.5), 0, ${CAP}); shrunkHitRate = (held + 2) / (decided + 4); RECORDED, NOT APPLIED (seat-authority reads seals; a weight is registered before it moves anything)`,
    resolvers: ["news", "would-do", "exit", "allocation", "halt", "construction"], unresolvedKinds: [...new Set(all.filter((g) => g.verdict === "UNRESOLVED").map((g) => g.kind + ": " + g.note))].slice(0, 20),
    contract: "Grades are the record; weights come in evening two. Nothing here changes a claim, an authority or a trade. A seat's record is read at >= 20 graded claims." };
  if (!dry) writeJsonAtomic(OUT, out);
  console.log(`SEAT CLAIMS GRADER — ${claims.length} claims · ${all.length} graded (${fresh.length} tonight) · ${pending.length} pending${dry ? " (DRY)" : ""}`);
  for (const [seat, s] of Object.entries(bySeat)) console.log(`   ${seat.padEnd(22)} claims ${String(s.claims || 0).padStart(2)}  held ${s.held}  failed ${s.failed}  unresolved ${s.unresolved}  pending ${s.pending}  record ${s.record}`);
  for (const g of fresh) console.log(`     #${g.seq} ${g.seat} ${g.kind} -> ${g.verdict} ${g.number ?? ""} (${g.method}${g.note ? "; " + g.note : ""})`);
})().catch((e) => { console.error("SEAT CLAIMS GRADER — failed: " + e.message); process.exit(1); });
