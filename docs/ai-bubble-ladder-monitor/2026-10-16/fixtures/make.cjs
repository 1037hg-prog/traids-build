#!/usr/bin/env node
"use strict";
/**
 * MATERIALISE A FIXTURE — writes one of specs.cjs's synthetic stores to a directory, so a reviewer can look at the
 * rows the selftest reads, and so the staged monitor can be run against one by hand:
 *
 *   node docs/ai-bubble-ladder-monitor/2026-10-16/fixtures/make.cjs --list
 *   node docs/ai-bubble-ladder-monitor/2026-10-16/fixtures/make.cjs b1-cross --out /tmp/lad-b1-cross
 *   node docs/ai-bubble-ladder-monitor/2026-10-16/fixtures/make.cjs --all --out /tmp/lad-fixtures
 *
 * It refuses to write into a directory that holds anything but <SYM>.json files of its own making, and it writes
 * nowhere by default. It is a tool of this package: nothing in staged/ reads it.
 *
 * Exit 0 written / listed · 1 refused or failed · 2 usage.
 */
const fs = require("fs"), path = require("path");
const S = require("./specs.cjs");

const args = process.argv.slice(2);
const want = args.filter((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--out");
const ALL = args.includes("--all"), LIST = args.includes("--list");
const outAt = args.indexOf("--out"), OUT = outAt >= 0 ? args[outAt + 1] : null;

if (LIST) { for (const [n, s] of Object.entries(S.SPECS)) console.log(`${n.padEnd(12)} ${s.from}..${s.end}  ${S.sessions(s.from, s.end).length} sessions  symbols ${Object.keys(s.symbols).join(", ")}`); process.exit(0); }
const names = ALL ? Object.keys(S.SPECS) : want;
if (!names.length || !OUT) { console.log("usage: node fixtures/make.cjs (<name> ... | --all) --out <dir>   |   --list\nNothing was written."); process.exit(2); }
for (const n of names) if (!S.SPECS[n]) { console.error(`no fixture named ${n} (--list shows them)`); process.exit(2); }

for (const n of names) {
  const dir = names.length > 1 ? path.join(OUT, n) : OUT;
  try {
    const have = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const stray = have.filter((f) => !/^[A-Z]+\.json$/.test(f));
    if (stray.length) { console.error(`${dir} holds files this tool did not write (${stray.slice(0, 5).join(", ")}) — refusing`); process.exit(1); }
    fs.mkdirSync(dir, { recursive: true });
    const st = S.store(n);
    for (const [sym, rows] of Object.entries(st)) fs.writeFileSync(path.join(dir, `${sym}.json`), JSON.stringify(rows));
    const first = Object.values(st)[0];
    console.log(`${n.padEnd(12)} -> ${dir}  ${Object.keys(st).length} symbols, ${first.length} rows ${first[0].d}..${first[first.length - 1].d}`);
  } catch (e) { console.error(`${n}: ${e.message}`); process.exit(1); }
}
