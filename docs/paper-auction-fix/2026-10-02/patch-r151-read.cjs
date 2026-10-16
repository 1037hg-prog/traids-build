// PAPER-AUCTION-FIX 2026-10-02 — patch for backend/r151-read.js. R151 is FROZEN execution-void (succeeded by R311) by the operator's
// decision of 2026-10-02 ("yes"). The freeze is a CONSTANT in the reader (review 2026-10-02): it no longer waits on the registry edit,
// so if the registry step of the deploy slips past the 2026-10-07 read date the void record is still never read or sealed. The reader
// prints the freeze and exits 0 — no read, no r151-read.json, no seal. Everything else is unchanged.
// INPUT PINNED (review 2026-10-02): the live reader must hash to LIVE_SHA256. At deploy, RE-RUN this patch and copy its fresh output.
// Usage: node docs/paper-auction-fix/2026-10-02/patch-r151-read.cjs [<backend dir>] [<out file>]
//        default out: backend/r151-read.pending-auctionfix.js — never the live file.
const fs = require("fs"), path = require("path");
const BK = process.argv[2] || path.resolve(__dirname, "../../../backend");
const SRC = path.join(BK, "r151-read.js"), OUTF = process.argv[3] || path.join(BK, "r151-read.pending-auctionfix.js");
if (path.resolve(OUTF) === path.resolve(SRC) || !/\.pending-auctionfix\.js$/.test(OUTF)) throw new Error("refusing: the output must be a separate *.pending-auctionfix.js file, never the live runner");
let s = fs.readFileSync(SRC, "utf8");
const LIVE_SHA256 = "7c0d56cfa757b8f8f3b17e43ee6bfd2be26a8d1ea76cb180bde76274b5095dc3";   // backend/r151-read.js as reviewed 2026-10-02 (6,054 bytes, unchanged since 2026-09-23)
const gotSha = require("crypto").createHash("sha256").update(s).digest("hex");
if (gotSha !== LIVE_SHA256) throw new Error(`live reader changed since the 2026-10-02 review (sha256 ${gotSha.slice(0, 12)}… != ${LIVE_SHA256.slice(0, 12)}…) — re-review before patching`);
const rep = (a, b, tag) => { const n = s.split(a).length - 1; if (n !== 1) throw new Error(`${tag}: expected 1 match, found ${n}`); s = s.replace(a, () => b); };
rep(` * official close (SIP daily bar, adjustment raw) and counted as a trade with markedAtEnd: true.
`,
` * official close (SIP daily bar, adjustment raw) and counted as a trade with markedAtEnd: true.
 * PAPER-AUCTION-FIX 2026-10-02: R151 is FROZEN execution-void by the operator's decision of 2026-10-02 (Alpaca paper barely fills the
 * opg/cls orders it was built on; 1 completed trade in 7 sessions). The freeze is the constant FROZEN_BY_OPERATOR below, independent of
 * the registry edit: this reader prints it and exits 0 without reading or sealing. The successor R311 (same rule, day orders) is read by
 * backend/r311-read.js.
`, "H1 header");
rep(`  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R151");
`,
`  const FROZEN_BY_OPERATOR = "2026-10-02";   // PAPER-AUCTION-FIX 2026-10-02: execution-void, operator 'yes' — independent of the registry edit
  if (FROZEN_BY_OPERATOR) { console.log(\`R151 FROZEN \${FROZEN_BY_OPERATOR} — execution-void; never read, nothing sealed; successor R311 reads via backend/r311-read.js (PAPER-AUCTION-FIX 2026-10-02)\`); process.exit(0); }   // PAPER-AUCTION-FIX 2026-10-02
  const reg = JSON.parse(fs.readFileSync(D("test-registry.json"), "utf8")), t = reg.preregistered.find((x) => x.id === "R151");
`, "H2 frozen-exit");
fs.writeFileSync(OUTF, s); console.log("written", OUTF, s.length, "bytes");
