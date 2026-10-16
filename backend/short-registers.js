/**
 * SHORT REGISTERS — the only place a named fund's SHORTS are printed (operator, 2026-09-14: "add the short registers").
 *
 * Under the EU/UK short-selling regime every holder net short >= 0.5% of a listed company is published by name, with the size
 * and the date the position crossed a threshold. This feed pulls the FCA's daily file (UK, every disclosure since 2013, one
 * workbook, ~3 MB) and normalises it into an append-only ledger: data/short-registers.jsonl, one row per (holder, ISIN, date, size)
 * the first night it is seen. Nothing here is a signal: it is a population. Any question asked of it (does a new named short from
 * a top-decile filer predict the next quarter against a same-sector control, net of cost?) is REGISTERED before it is read, in the
 * #70 whale family. Germany (BaFin via Bundesanzeiger) and the other national registers are not wired yet — the page is dynamic;
 * noted as the next source in the change registry.
 *
 * Fail closed: a download that is not a workbook, or a workbook without the five known columns, writes nothing and exits 1.
 * Runs nightly in the close chain; --dry parses and reports without writing.
 */
const fs = require("fs"), path = require("path");
const { writeJsonAtomic } = require("./lib/atomic-write.js");
const ExcelJS = require("exceljs");
const D = (f) => path.join(__dirname, "data", f);
const DIR = D("short-registers"), LEDGER = D("short-registers.jsonl"), OUT = D("short-registers.json");
const FCA_URL = "https://www.fca.org.uk/publication/data/short-positions-daily-update.xlsx";
const dry = process.argv.includes("--dry");
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const key = (r) => `${r.source}|${r.holder}|${r.isin}|${r.date}|${r.pct}`;

async function fetchFCA() {
  fs.mkdirSync(DIR, { recursive: true });
  const f = path.join(DIR, `fca-${today}.xlsx`);
  const r = await fetch(FCA_URL, { signal: AbortSignal.timeout(90000), headers: { "User-Agent": "traids-short-registers/1.0" } });
  if (!r.ok) throw new Error(`FCA download ${r.status}`);
  const ct = r.headers.get("content-type") || "";
  if (!/spreadsheet|octet-stream/.test(ct)) throw new Error(`FCA download is not a workbook (${ct})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!dry) fs.writeFileSync(f, buf);
  return buf;
}
async function parseFCA(buf) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const rows = [];
  for (const ws of wb.worksheets) {
    const h = Array.from(ws.getRow(1).values || [], (v) => String(v ?? "").trim().toLowerCase());   // exceljs row values are sparse (index 0 empty)
    const ci = (name) => h.findIndex((x) => x.includes(name));
    const iH = ci("holder"), iI = ci("issuer"), iS = ci("isin"), iP = ci("short position"), iD = ci("date");
    if ([iH, iI, iS, iP, iD].some((i) => i < 0)) continue;
    ws.eachRow((row, n) => {
      if (n === 1) return; const v = row.values;
      const holder = String(v[iH] ?? "").trim(), issuer = String(v[iI] ?? "").trim(), isin = String(v[iS] ?? "").trim();
      const pct = Number(v[iP]); let d = v[iD]; d = d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? "").slice(0, 10);
      if (!holder || !isin || !Number.isFinite(pct) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      rows.push({ source: "FCA", sheet: ws.name, holder, issuer, isin, pct, date: d });
    });
  }
  if (!rows.length) throw new Error("FCA workbook parsed to zero rows — columns changed?");
  return rows;
}

(async () => {
  const buf = await fetchFCA(); const rows = await parseFCA(buf);
  const seen = new Set(); try { for (const l of fs.readFileSync(LEDGER, "utf8").split("\n")) { if (!l.trim()) continue; try { seen.add(key(JSON.parse(l))); } catch {} } } catch {}
  const fresh = rows.filter((r) => !seen.has(key(r)));
  if (!dry && fresh.length) fs.appendFileSync(LEDGER, fresh.map((r) => JSON.stringify({ ...r, seenAt: today })).join("\n") + "\n");
  // ---- summary: latest disclosure per (holder, ISIN) is the standing position; >= 0.5% means open, below = closed -------
  const latest = new Map();
  for (const r of rows) { const k = r.holder + "|" + r.isin; const p = latest.get(k); if (!p || r.date > p.date) latest.set(k, r); }
  const open = [...latest.values()].filter((r) => r.pct >= 0.5);
  const byHolder = {}; for (const r of open) (byHolder[r.holder] ||= []).push(r);
  const topHolders = Object.entries(byHolder).sort((a, b) => b[1].length - a[1].length).slice(0, 20).map(([h, v]) => ({ holder: h, openPositions: v.length, grossPct: +v.reduce((s, r) => s + r.pct, 0).toFixed(2) }));
  const byIssuer = {}; for (const r of open) (byIssuer[r.issuer] ||= []).push(r);
  const mostShorted = Object.entries(byIssuer).map(([i, v]) => ({ issuer: i, holders: v.length, totalPct: +v.reduce((s, r) => s + r.pct, 0).toFixed(2) })).sort((a, b) => b.totalPct - a.totalPct).slice(0, 20);
  const latestDate = rows.map((r) => r.date).sort().pop();
  const recent = rows.filter((r) => r.date >= new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10));
  const out = { spec: "short-registers-v1", asOf: new Date().toISOString(), sources: [{ id: "FCA", url: FCA_URL, sheets: [...new Set(rows.map((r) => r.sheet))], rows: rows.length, latestDisclosureDate: latestDate }],
    notWired: ["BaFin/Bundesanzeiger (DE) — dynamic page, next", "AMF (FR), CONSOB (IT), CNMV (ES), AFM (NL) — one file each, not started"],
    ledger: { file: "data/short-registers.jsonl", totalRows: seen.size + fresh.length, newTonight: fresh.length },
    standing: { openPositions: open.length, holders: Object.keys(byHolder).length, issuers: Object.keys(byIssuer).length, disclosuresLast7Days: recent.length },
    topHolders, mostShorted,
    contract: "A POPULATION, not a signal. Any question asked of it is registered in the #70 whale family before it is read. Named holders and issuers are public regulatory disclosures." };
  if (!dry) writeJsonAtomic(OUT, out);
  console.log(`SHORT REGISTERS — FCA ${rows.length} disclosures since ${rows.map((r) => r.date).sort()[0]}, latest ${latestDate} · ${open.length} standing positions >= 0.5% across ${Object.keys(byHolder).length} holders / ${Object.keys(byIssuer).length} issuers · ${fresh.length} new row(s) tonight${dry ? " (DRY)" : ""}`);
  console.log("   top holders: " + topHolders.slice(0, 6).map((h) => `${h.holder} (${h.openPositions})`).join(" · "));
  console.log("   most shorted: " + mostShorted.slice(0, 6).map((i) => `${i.issuer} ${i.totalPct}%`).join(" · "));
})().catch((e) => { console.error(`SHORT REGISTERS — failed: ${e.message}`); process.exit(1); });
