const fs = require("fs"), path = require("path"); const f = path.join(__dirname, "..", "src", "App.jsx"); let s = fs.readFileSync(f, "utf8");
const rep = (a, b) => { if (!s.includes(a)) { console.error("anchor missing:", a.slice(0, 70)); process.exit(2); } s = s.replace(a, b); };
// shared trimmer, module level, just before the component's doc comment
rep("/**\n * MOVERS RADAR (monitor-only) — moved here",
"// Only the rows the radar can ever show are kept (top 20 each way + the 20 busiest): the full ~1,100-name list is ~120 KB, and on the real\n// app's origin localStorage is already near its quota (positions + trade log), where setItem throws and the list silently never arrived (2026-09-18).\nconst trimMovers = (mv) => { const pick = new Set(); const take = (arr) => arr.slice(0, 20).forEach(m => pick.add(m)); take([...mv].sort((a, b) => b.movePct - a.movePct)); take([...mv].sort((a, b) => a.movePct - b.movePct)); take(mv.filter(m => m.rvol != null).sort((a, b) => b.rvol - a.rvol)); return [...pick].map(({ cls, sym, px, movePct, rvol }) => ({ cls, sym, px, movePct, rvol })); };\n/**\n * MOVERS RADAR (monitor-only) — moved here");
// auto-fill: show from memory first, then persist the trimmed list
rep('try { localStorage.setItem("traids_movers", JSON.stringify({ asOf: new Date().toISOString(), src: "auto", barDate, rvolBasis, movers: kept })); } catch {}\n        setData(read());',
    'const fresh = { asOf: new Date().toISOString(), src: "auto", barDate, rvolBasis, total: kept.length, movers: trimMovers(kept) };\n        setData(fresh);                                              // display never depends on storage succeeding\n        try { localStorage.setItem("traids_movers", JSON.stringify(fresh)); } catch {}');
// board-scan handoff: trimmed too
rep('JSON.stringify({ asOf: builtBoard.asOf.toISOString(), src: "board scan", movers }))', 'JSON.stringify({ asOf: builtBoard.asOf.toISOString(), src: "board scan", total: movers.length, movers: trimMovers(movers) }))');
rep('· {mv.length} names · delayed', '· {data.total || mv.length} names scanned · delayed');
fs.writeFileSync(f + ".tmp", s); fs.renameSync(f + ".tmp", f); console.log("ok");
