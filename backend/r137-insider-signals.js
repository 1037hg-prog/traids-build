#!/usr/bin/env node
/**
 * R137 step 1 — build the CLUSTER INSIDER BUY signal list from the SEC's own bulk data sets. OUTCOME-FREE: no price is read here.
 * Source: data/sec-insider/<yyyy>q<n>_form345.zip (SUBMISSION, NONDERIV_TRANS, REPORTINGOWNER), 2019q1..2025q4.
 * A QUALIFYING PURCHASE: original Form 4 (not 4/A), non-derivative, TRANS_CODE P, acquired, price > 0, shares > 0, common/ordinary stock,
 * reporting owner an Officer or Director (a pure 10% holder does not count). An insider qualifies in a filing when those rows total >= $10,000.
 * A SIGNAL: the filing that brings the number of DISTINCT qualifying insiders at one issuer to THREE within 30 calendar days, by FILING
 * date (the public moment). One signal per issuer per 180 days. Signals filed 2019-01-01..2025-03-31. Writes data/r137-signals.json.
 */
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process"); const { writeJsonAtomic } = require("./lib/atomic-write.js");
const DIR = path.join(__dirname, "data", "sec-insider"), MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const iso = (d) => { const m = /^(\d{2})-([A-Z]{3})-(\d{4})$/.exec(String(d || "").trim()); return m ? `${m[3]}-${MON[m[2]]}-${m[1]}` : null; };
const tsv = (zip, name) => { const txt = execFileSync("unzip", ["-p", path.join(DIR, zip), name], { maxBuffer: 1 << 30 }).toString("utf8"), lines = txt.split(/\r?\n/), h = lines[0].split("\t"); return { h: Object.fromEntries(h.map((k, i) => [k, i])), rows: lines.slice(1).filter(Boolean).map((l) => l.split("\t")) }; };
const buys = [];   // { cik, sym, name, owner, filed, usd }
for (const zip of fs.readdirSync(DIR).filter((f) => /_form345\.zip$/.test(f)).sort()) {
  const S = tsv(zip, "SUBMISSION.tsv"), T = tsv(zip, "NONDERIV_TRANS.tsv"), O = tsv(zip, "REPORTINGOWNER.tsv");
  const sub = new Map(); for (const r of S.rows) if (r[S.h.DOCUMENT_TYPE] === "4") sub.set(r[S.h.ACCESSION_NUMBER], { filed: iso(r[S.h.FILING_DATE]), cik: r[S.h.ISSUERCIK], sym: String(r[S.h.ISSUERTRADINGSYMBOL] || "").toUpperCase().trim(), name: r[S.h.ISSUERNAME] });
  const own = new Map(); for (const r of O.rows) { const rel = r[O.h.RPTOWNER_RELATIONSHIP] || ""; if (/officer|director/i.test(rel)) (own.get(r[O.h.ACCESSION_NUMBER]) || own.set(r[O.h.ACCESSION_NUMBER], []).get(r[O.h.ACCESSION_NUMBER])).push(r[O.h.RPTOWNERCIK]); }
  const usdBy = new Map();
  for (const r of T.rows) { if (r[T.h.TRANS_CODE] !== "P" || r[T.h.TRANS_ACQUIRED_DISP_CD] !== "A") continue; const acc = r[T.h.ACCESSION_NUMBER]; if (!sub.has(acc) || !own.has(acc)) continue;
    if (!/common|ordinary|class [ab]\b/i.test(r[T.h.SECURITY_TITLE] || "")) continue; const sh = +r[T.h.TRANS_SHARES], px = +r[T.h.TRANS_PRICEPERSHARE]; if (!(sh > 0) || !(px > 0)) continue; usdBy.set(acc, (usdBy.get(acc) || 0) + sh * px); }
  for (const [acc, usd] of usdBy) { if (usd < 10000) continue; const s = sub.get(acc); if (!s.filed || !/^[A-Z][A-Z.\-]{0,5}$/.test(s.sym)) continue; for (const owner of new Set(own.get(acc))) buys.push({ ...s, owner, usd: Math.round(usd) }); }
  console.log(zip, "→ qualifying insider-filings so far:", buys.length);
}
buys.sort((a, b) => (a.filed < b.filed ? -1 : 1));
const byIssuer = new Map(); for (const b of buys) (byIssuer.get(b.cik) || byIssuer.set(b.cik, []).get(b.cik)).push(b);
const dayDiff = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5, signals = [];
for (const [cik, list] of byIssuer) { let last = null;
  for (let i = 0; i < list.length; i++) { const cur = list[i]; if (last && dayDiff(last, cur.filed) < 180) continue;   // one signal per issuer per 180 days
    const win = list.slice(0, i + 1).filter((x) => dayDiff(x.filed, cur.filed) <= 30), owners = new Set(win.map((x) => x.owner));
    if (owners.size >= 3) { signals.push({ cik, sym: cur.sym, name: cur.name, signalDate: cur.filed, buyers: owners.size, usd: win.reduce((t, x) => t + x.usd, 0) }); last = cur.filed; } } }
const kept = signals.filter((s) => s.signalDate >= "2019-01-01" && s.signalDate <= "2025-03-31");
const byYear = {}; for (const s of kept) byYear[s.signalDate.slice(0, 4)] = (byYear[s.signalDate.slice(0, 4)] || 0) + 1;
writeJsonAtomic(path.join(__dirname, "data", "r137-signals.json"), { spec: "r137-signals-v1", builtAt: new Date().toISOString(), outcomeFree: true, qualifyingInsiderFilings: buys.length, issuersWithAnyBuy: byIssuer.size, signals: kept });
console.log(`\nqualifying insider purchase filings ${buys.length} at ${byIssuer.size} issuers → cluster signals ${kept.length} (distinct tickers ${new Set(kept.map((s) => s.sym)).size})`, JSON.stringify(byYear));
