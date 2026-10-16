#!/usr/bin/env node
/**
 * OPS HEALTH FIX 2026-10-05 (d) — early-close triggers for the R295 close-arm tasks. Registers NOTHING.
 *
 * "TRAIDS R295 close-arm 1341" / "1347" (automation\r295-close-arm.bat at 13:41 / 13:47 MT weekdays = 15:41 / 15:47 ET) were created
 * 2026-10-02 with one weekly trigger each. The "TRAIDS Close-Arm 1337/1344" pair (docs/close-arm-task/) also carries one-time triggers
 * at 10:37 / 10:44 MT on the NYSE early-close dates (13:00 ET close). This builds the R295 pair the same way: every element of the LIVE
 * definition kept verbatim (principal SID + S4U, IgnoreNew, WakeToRun, StartWhenAvailable, PT15M, the action, the offset-free weekly
 * trigger), plus one-time TimeTriggers at 10:41 / 10:47 MT (= 12:41 / 12:47 ET) on each early-close date, StartBoundary WITHOUT a UTC
 * offset (the 2026-10-02 DST lesson: an offset pins the trigger to UTC and it fires an hour early against the market after 11-01).
 * The description gains one sentence. Output: UTF-16 LE with BOM, CRLF — what `schtasks /create /xml` reads.
 *   node build-task-xml.cjs --capture   re-read the live definitions (schtasks /query /xml — read-only) into live-r295-<n>.xml
 *   node build-task-xml.cjs             build task-r295-<n>.xml from the captured live-r295-<n>.xml
 * NOTE (read before registering): r295-orb-forward.js --close-arm self-gates to a FIXED 15:30-15:50 ET and the R295 session process
 * closes out at a fixed 15:44 ET, so on an early-close date these new triggers fire and the script declines ("outside the 15:30-15:50
 * close-arm gate"). They become useful only when R295's own code learns the early close — see NOTES.md (d).
 */
"use strict";
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const DIR = __dirname, EARLY_CLOSE_DATES = ["2026-11-27", "2026-12-24", "2027-11-26"];   // = backend/lib/futures-bars.js EARLY_CLOSE / close-arm-runner EARLY_CLOSE_ET
const TASKS = [{ n: "1341", early: "10:41" }, { n: "1347", early: "10:47" }];
const nameOf = (n) => `TRAIDS R295 close-arm ${n}`;
const u16 = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s.replace(/\r?\n/g, "\r\n"), "utf16le")]);
const read16 = (f) => { const b = fs.readFileSync(f); if (!(b[0] === 0xff && b[1] === 0xfe)) throw new Error(`${path.basename(f)} is not UTF-16 LE with BOM`); return b.slice(2).toString("utf16le"); };
const one = (re, s, what) => { const m = s.match(re); if (!m) throw new Error(`live XML drift: ${what} not found`); if ((s.match(new RegExp(re.source, "g")) || []).length !== 1) throw new Error(`live XML drift: ${what} not unique`); return m; };

if (process.argv.includes("--capture")) {
  for (const t of TASKS) {
    const xml = execFileSync("schtasks", ["/query", "/tn", nameOf(t.n), "/xml"], { encoding: "utf8", windowsHide: true });
    if (!/<URI>\\TRAIDS R295 close-arm \d+<\/URI>/.test(xml)) throw new Error(`unexpected schtasks output for ${nameOf(t.n)}`);
    fs.writeFileSync(path.join(DIR, `live-r295-${t.n}.xml`), u16(xml.trim() + "\n"));
    console.log(`captured live-r295-${t.n}.xml (${nameOf(t.n)}, read-only query)`);
  }
}
for (const t of TASKS) {
  const live = read16(path.join(DIR, `live-r295-${t.n}.xml`));
  one(new RegExp(`<URI>\\\\${nameOf(t.n).replace(/ /g, " ")}</URI>`), live, "URI");
  one(/<LogonType>S4U<\/LogonType>/, live, "LogonType S4U");
  one(/<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/, live, "IgnoreNew");
  one(/<WakeToRun>true<\/WakeToRun>/, live, "WakeToRun true");
  one(/<ExecutionTimeLimit>PT15M<\/ExecutionTimeLimit>/, live, "ExecutionTimeLimit PT15M");
  one(/<Arguments>\/c "[^"]+\\automation\\r295-close-arm\.bat"<\/Arguments>/, live, "r295-close-arm.bat action");
  const weekly = one(/<StartBoundary>(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)<\/StartBoundary>/, live, "the one offset-free StartBoundary")[1];
  if (!weekly.endsWith(`T13:${t.n.slice(2)}:00`)) throw new Error(`live XML drift: weekly trigger ${weekly} is not 13:${t.n.slice(2)}`);
  if (/<TimeTrigger>/.test(live)) throw new Error("live XML already has a TimeTrigger — rebuild by hand");
  const desc = one(/<Description>([^<]*)<\/Description>/, live, "Description")[1];
  const ind = (k) => "  ".repeat(k);
  const add = EARLY_CLOSE_DATES.flatMap((d) => [`${ind(2)}<TimeTrigger>`, `${ind(3)}<StartBoundary>${d}T${t.early}:00</StartBoundary>`, `${ind(3)}<Enabled>true</Enabled>`, `${ind(2)}</TimeTrigger>`]).join("\n");
  let xml = live.replace(/\r\n/g, "\n")
    .replace(`<Description>${desc}</Description>`, `<Description>${desc}; plus ${t.early} MT (= ${String(+t.early.slice(0, 2) + 2).padStart(2, "0")}${t.early.slice(2)} ET) on NYSE early-close dates ${EARLY_CLOSE_DATES.join(", ")} (ops health fix 2026-10-05)</Description>`)
    .replace(/\n(\s*)<\/Triggers>/, (m, sp) => `\n${add}\n${sp}</Triggers>`);
  xml = xml.trim() + "\n";
  // proofs on the output
  if (/T\d\d:\d\d:\d\d([+-]\d\d:\d\d|Z)<\/StartBoundary>/.test(xml)) throw new Error("an offset slipped into a StartBoundary");
  const bounds = [...xml.matchAll(/<StartBoundary>([^<]+)<\/StartBoundary>/g)].map((m) => m[1]);
  if (JSON.stringify(bounds) !== JSON.stringify([weekly, ...EARLY_CLOSE_DATES.map((d) => `${d}T${t.early}:00`)])) throw new Error("trigger set is not weekly + the early-close dates: " + bounds.join(", "));
  const strip = (s) => s.replace(/<Description>[^<]*<\/Description>/, "").replace(/<TimeTrigger>[\s\S]*?<\/TimeTrigger>/g, "").replace(/>\s+</g, "><").trim();
  if (strip(xml) !== strip(live.replace(/\r\n/g, "\n"))) throw new Error("something other than the description and the TimeTriggers changed");
  fs.writeFileSync(path.join(DIR, `task-r295-${t.n}.xml`), u16(xml));
  console.log(`wrote task-r295-${t.n}.xml — ${nameOf(t.n)}: weekly ${weekly.slice(11, 16)} local + ${EARLY_CLOSE_DATES.length} early-close one-time triggers at ${t.early}; everything else = live definition`);
}
