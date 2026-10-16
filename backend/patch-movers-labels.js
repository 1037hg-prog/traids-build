const fs = require("fs"), path = require("path"); const f = path.join(__dirname, "..", "src", "App.jsx"); let s = fs.readFileSync(f, "utf8");
const rep = (a, b) => { if (!s.includes(a)) { console.error("anchor missing:", a.slice(0, 60)); process.exit(2); } s = s.replace(a, b); };
rep('JSON.stringify({ asOf: builtBoard.asOf.toISOString(), movers }))', 'JSON.stringify({ asOf: builtBoard.asOf.toISOString(), src: "board scan", movers }))');
rep('from the board scan at {stamp.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" })} ET · {mv.length} names</span>}',
    '{data.src === "board scan" ? "from the board scan" : "auto-filled"} at {stamp.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" })} ET{data.barDate ? ` · daily bars dated ${data.barDate}` : ""} · {mv.length} names · delayed{busy ? " · refreshing…" : ""}</span>}');
rep('{stamp && !isNaN(stamp) ? `No scan today — the last list is from ${etDay(stamp)} and is not shown.` : "No scan yet today."} The radar fills from the Daily Board scan; open the Daily Board and rebuild to populate it. Nothing substituted.',
    '{busy ? "Fetching today’s bars for the scan universe…" : (stamp && !isNaN(stamp) ? `Nothing from today — the last list is from ${etDay(stamp)} and is not shown.` : "No list yet today.") + " The radar fills itself every 10 minutes; if this stays blank the bar feeds did not answer. Nothing substituted."}');
fs.writeFileSync(f + ".tmp", s); fs.renameSync(f + ".tmp", f); console.log("ok");
