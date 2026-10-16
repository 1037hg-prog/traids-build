#!/usr/bin/env node
/** Seals an alpha-hunt read (R164-R170): node backend/seal-hunt.js <KEY>. Reads data/hunt/<KEY>-holdout.json (and -discovery.json),
 *  applies the registered pass rule — the script's own verdict AND the best-of-7 family bar on the holdout's primary (net) t — and writes
 *  read-seals.json, the registry status and the agent ledger. Refuses if already sealed or if the holdout has not been read. */
const fs = require("fs"), path = require("path"); const { writeJsonAtomic } = require("./lib/atomic-write.js"); const D = (f) => path.join(__dirname, "data", f);
const KEY = process.argv[2]; if (!KEY) { console.error("usage: seal-hunt.js <KEY>"); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.huntKey === KEY); if (!t) { console.error(`no registry entry for ${KEY}`); process.exit(2); }
const seals = JSON.parse(fs.readFileSync(D("read-seals.json"), "utf8")); if (seals.tests[t.id]) { console.error(`${t.id} already sealed`); process.exit(2); }
const hf = D(`hunt/${KEY}-holdout.json`); if (!fs.existsSync(hf)) { console.error(`${KEY} holdout not read`); process.exit(2); }
const h = JSON.parse(fs.readFileSync(hf, "utf8")), df = D(`hunt/${KEY}-discovery.json`), d = fs.existsSync(df) ? JSON.parse(fs.readFileSync(df, "utf8")) : null;
// primary net t: the first NET t field in the holdout summary (tNW / tPlain), never a gross one
const flat = JSON.stringify(h), m = flat.match(/"(tNW|tPlain|tNet|tNWnet)":(-?[0-9.]+)/); const tPrimary = m ? +m[2] : null;
const scriptPass = /^PASS/.test(String(h.verdict)), familyPass = tPrimary != null && tPrimary >= t.bar.familyBar;
const verdict = scriptPass && familyPass ? "PASS" : "DID NOT PASS";
const brief = (o) => JSON.stringify(o).replace(/"series":\[[^\]]*\]/g, '"series":[…]').slice(0, 420);
const text = `${verdict} — script verdict ${h.verdict}; holdout primary t ${tPrimary} vs script bar ${t.bar.scriptBar} and best-of-7 family bar ${t.bar.familyBar}. Holdout: ${brief(h.result || h.summary || h.results || h.carried || {})}. Discovery: ${d ? brief(d.result || d.summary || d.results || {}) : "n/a"}.`;
seals.tests[t.id] = { sealedOn: new Date().toISOString().slice(0, 10), unit: t.unit || "months", verdict: text }; seals.lastRun = new Date().toISOString(); writeJsonAtomic(D("read-seals.json"), seals);
t.status = "READ " + new Date().toISOString().slice(0, 10) + " — " + text; reg.asOf = new Date().toISOString(); writeJsonAtomic(D("test-registry.json"), reg);
fs.appendFileSync(D("agent-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "GOVERNANCE", actor: "assistant", action: "seal-read", test: t.id, huntKey: KEY, verdict, tPrimary }) + "\n");
console.log(`${t.id} ${KEY} sealed: ${verdict} (t ${tPrimary}; family bar ${t.bar.familyBar})`);
