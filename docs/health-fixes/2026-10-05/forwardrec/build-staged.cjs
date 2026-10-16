#!/usr/bin/env node
/**
 * forwardrec — build the staged copies and manifest.json.
 *
 *   node build-staged.cjs --from <work dir>     staged/<rel> <- <work dir>/<rel>, written in the LIVE file's own newline style; base shas from the LIVE files now
 *   node build-staged.cjs --rebase-chain        automation/close-chain.cjs ONLY: re-apply this package's three hunks (chain-hunks.json) to the
 *                                               CURRENT live file (e.g. after another package deployed its own close-chain change), rewrite
 *                                               staged/automation/close-chain.cjs and its baseSha. Refuses unless every hunk's old text occurs
 *                                               exactly once. Review the new staged file before deploying.
 *
 * Each staged file keeps its live file's newline style (all of this package's targets are LF today, measured byte-wise 2026-10-05); new files
 * are LF like most of backend/lib; no BOM. New files (baseSha null) must not exist live at deploy time.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = process.env.FORWARDREC_ROOT || "C:/Users/joshc/Downloads/traids (2)/traids-bundle", PKG = __dirname, STAGED = path.join(PKG, "staged");   // FORWARDREC_ROOT: a mock repo, for testing
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const TARGETS = [
  { rel: "backend/lib/forward-catchup.js", isNew: true },
  { rel: "backend/lib/r236-months.js", isNew: true },
  { rel: "backend/r191-crypto-trend-forward.js" },
  { rel: "backend/r231-crypto-vote-sized-forward.js" },
  { rel: "backend/r236-tv-forward.js" },
  { rel: "backend/c2-ares-forward.js" },
  { rel: "automation/close-chain.cjs" },
];
const crlf = (t) => t.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
const styleOf = (buf) => (buf.toString("utf8").includes("\r\n") ? "CRLF" : "LF");   // a target keeps the newline style it has live (new files: LF, as 38 of 40 backend/lib files)
const inStyle = (t, style) => (style === "CRLF" ? crlf(t) : t.replace(/\r\n/g, "\n"));
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

if (process.argv.includes("--rebase-chain")) {
  const rel = "automation/close-chain.cjs", live = fs.readFileSync(path.join(ROOT, rel)), hunks = JSON.parse(fs.readFileSync(path.join(PKG, "chain-hunks.json"), "utf8"));
  let t = live.toString("utf8").replace(/\r\n/g, "\n");
  for (const h of hunks) { const n = t.split(h.old).length - 1; if (n !== 1) { console.error(`REFUSED: hunk "${h.name}" old text occurs ${n} times in the live file`); process.exit(1); } t = t.replace(h.old, () => h.new); }
  const style = styleOf(live), out = Buffer.from(inStyle(t, style), "utf8"); fs.writeFileSync(path.join(STAGED, rel), out);   // the live file's own style (another package may have changed it)
  const man = JSON.parse(fs.readFileSync(path.join(PKG, "manifest.json"), "utf8")), e = man.files.find((x) => x.rel === rel);
  e.baseSha = sha(live); e.stagedSha = sha(out); e.newline = style; man.rebasedChainAt = new Date().toISOString(); fs.writeFileSync(path.join(PKG, "manifest.json"), JSON.stringify(man, null, 1) + "\n");
  console.log(`rebased ${rel} (${style}): base ${e.baseSha.slice(0, 12)} -> staged ${e.stagedSha.slice(0, 12)} — review staged/${rel}, then node selftest.cjs and node deploy.cjs --dry`); process.exit(0);
}

const from = arg("--from"); if (!from) { console.error("usage: node build-staged.cjs --from <work dir> | --rebase-chain"); process.exit(2); }
const files = [];
for (const t of TARGETS) {
  const livePath = path.join(ROOT, t.rel), style = t.isNew ? "LF" : styleOf(fs.readFileSync(livePath));
  const src = fs.readFileSync(path.join(from, t.rel), "utf8"), out = Buffer.from(inStyle(src, style), "utf8");
  if (out[0] === 0xef && out[1] === 0xbb) throw new Error(`BOM in ${t.rel}`);
  const baseSha = t.isNew ? null : sha(fs.readFileSync(livePath));
  if (t.isNew && fs.existsSync(livePath)) throw new Error(`${t.rel} is new in this package but exists live`);
  // the work copy was edited from <rel>.orig; if the live file moved since, this staged copy would drop someone's change — refuse
  if (!t.isNew && fs.readFileSync(livePath, "utf8").replace(/\r\n/g, "\n") !== fs.readFileSync(path.join(from, t.rel + ".orig"), "utf8")) throw new Error(`${t.rel} changed live since the work copy was taken — rebuild the work copy`);
  fs.mkdirSync(path.dirname(path.join(STAGED, t.rel)), { recursive: true }); fs.writeFileSync(path.join(STAGED, t.rel), out);
  files.push({ rel: t.rel, baseSha, stagedSha: sha(out), newline: style });
}
// the close-chain hunks, kept so --rebase-chain can re-apply them to a newer live file
const orig = fs.readFileSync(path.join(ROOT, "automation/close-chain.cjs"), "utf8").replace(/\r\n/g, "\n"), mine = fs.readFileSync(path.join(from, "automation/close-chain.cjs"), "utf8");
const hunks = JSON.parse(fs.readFileSync(path.join(from, "chain-hunks.src.json"), "utf8"));
let check = orig; for (const h of hunks) { if (check.split(h.old).length !== 2) throw new Error(`chain hunk ${h.name} not unique in live`); check = check.replace(h.old, () => h.new); }
if (check !== mine.replace(/\r\n/g, "\n")) throw new Error("chain-hunks.src.json does not reproduce the staged close-chain.cjs");
fs.writeFileSync(path.join(PKG, "chain-hunks.json"), JSON.stringify(hunks, null, 1) + "\n");
fs.writeFileSync(path.join(PKG, "manifest.json"), JSON.stringify({ package: "forwardrec", builtAt: new Date().toISOString(), files }, null, 1) + "\n");
for (const f of files) console.log(`${f.rel.padEnd(44)} base ${f.baseSha ? f.baseSha.slice(0, 12) : "(new)       "} staged ${f.stagedSha.slice(0, 12)}`);
