#!/usr/bin/env node
/**
 * OPERATOR ITEMS — the things only the operator can do. (2026-09-09)
 *
 * WHY. This shop tracks 181 registered hypotheses to the day, and tracked the handful of actions
 * that require a HUMAN nowhere at all. They lived in my working memory and in documents nobody
 * opens: the Schwab re-authorisation that expires on a 7-day token, an elevated script waiting to
 * be run, an account only the operator can create. Every one of them is a single point of failure
 * with no writer, which is the same defect the seat wave and the funding-carry collector had, in a
 * place where the fix is a sentence rather than a script.
 *
 * So they live in a file, they surface in the end-of-day message on the day they matter, and they
 * go loud when they are overdue. Nothing here does the item — it only refuses to let it be
 * forgotten. An item with an `estMinutes` is a promise about the operator's time, so it is stated
 * honestly or left out.
 *
 * Usage:
 *   node backend/operator-items.js --list
 *   node backend/operator-items.js --add --title "..." --due YYYY-MM-DD [--mins N] [--what "..."] [--why "..."]
 *   node backend/operator-items.js --done <id>   |   --drop <id> --reason "..."
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const F = path.join(__dirname, "data", "operator-items.json");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

const load = () => { try { return JSON.parse(fs.readFileSync(F, "utf8")); } catch { return { spec: "operator-items-v1", items: [] }; } };
const save = (d) => writeJsonAtomic(F, d);

/** Items the operator should see tonight: due within `horizon` days, or already overdue. */
function dueItems(horizon = 3) {
  const t = today();
  return load().items
    .filter((i) => i.status === "open")
    .map((i) => ({ ...i, daysOut: Math.round((Date.parse(i.due) - Date.parse(t)) / 86400000) }))
    .filter((i) => i.daysOut <= horizon)
    .sort((a, b) => a.daysOut - b.daysOut);
}

/** One short line per item, written for a phone. Overdue items say so first. */
function line(i) {
  const when = i.daysOut < 0 ? `OVERDUE ${-i.daysOut}d` : i.daysOut === 0 ? "TODAY" : `in ${i.daysOut}d`;
  return `· [${when}] ${i.title}${i.estMinutes ? ` (~${i.estMinutes} min)` : ""}`;
}

module.exports = { dueItems, line, load };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const n = argv.indexOf(k); return n >= 0 ? argv[n + 1] : d; };
  const d = load();

  if (argv.includes("--add")) {
    const title = arg("--title"), due = arg("--due");
    if (!title || !due) { console.error("need --title and --due YYYY-MM-DD"); process.exit(1); }
    const id = "OI" + String(d.items.length + 1).padStart(3, "0");
    d.items.push({ id, title, what: arg("--what", null), why: arg("--why", null), blocks: arg("--blocks", null),
      due, estMinutes: arg("--mins") ? Number(arg("--mins")) : null, status: "open", addedAt: new Date().toISOString() });
    save(d); console.log(`added ${id} — ${title} (due ${due})`); process.exit(0);
  }
  if (argv.includes("--done") || argv.includes("--drop")) {
    const id = arg("--done") || arg("--drop"), it = d.items.find((x) => x.id === id);
    if (!it) { console.error("no such item:", id); process.exit(1); }
    it.status = argv.includes("--done") ? "done" : "dropped";
    it.closedAt = new Date().toISOString(); it.closeReason = arg("--reason", null);
    save(d); console.log(`${it.status} ${id} — ${it.title}`); process.exit(0);
  }

  const open = d.items.filter((i) => i.status === "open");
  console.log(`\n  OPERATOR ITEMS — ${open.length} open (${d.items.length} ever)\n`);
  for (const i of open.map((i) => ({ ...i, daysOut: Math.round((Date.parse(i.due) - Date.parse(today())) / 86400000) })).sort((a, b) => a.daysOut - b.daysOut)) {
    console.log(`  ${i.id}  ${i.due}  ${i.daysOut < 0 ? `OVERDUE ${-i.daysOut}d` : i.daysOut === 0 ? "TODAY" : `in ${i.daysOut}d`}`);
    console.log(`        ${i.title}${i.estMinutes ? `  (~${i.estMinutes} min of your time)` : ""}`);
    if (i.what) console.log(`        what:   ${i.what}`);
    if (i.why) console.log(`        why:    ${i.why}`);
    if (i.blocks) console.log(`        blocks: ${i.blocks}`);
    console.log("");
  }
}
