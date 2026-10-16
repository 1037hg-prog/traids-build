#!/usr/bin/env node
/**
 * reports-to-pdf.js — render report files (HTML or Markdown) to PDF with the repo's Playwright Chromium, so they read on a phone.
 *   node backend/reports-to-pdf.js <out-dir> file1.html file2.md ...      → prints one PDF path per line
 * Markdown gets a minimal readable stylesheet. HTML pages render in light mode at Letter width. Nothing is uploaded anywhere.
 */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(ROOT, ".playwright");
const [outDir, ...files] = process.argv.slice(2);
if (!outDir || !files.length) { console.error("usage: reports-to-pdf.js <out-dir> files..."); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });
const mdToHtml = (md) => {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = md.split(/\r?\n/); const out = []; let inCode = false, inTable = false, inList = false;
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\*([^*]+)\*/g, "<i>$1</i>").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a href=\"$2\">$1</a>");
  for (const ln of lines) {
    if (/^```/.test(ln)) { inCode = !inCode; out.push(inCode ? "<pre>" : "</pre>"); continue; }
    if (inCode) { out.push(esc(ln)); continue; }
    if (/^\|/.test(ln)) { if (/^\|\s*-/.test(ln)) continue; if (!inTable) { out.push("<table>"); inTable = true; } out.push("<tr>" + ln.split("|").slice(1, -1).map((c) => "<td>" + inline(c.trim()) + "</td>").join("") + "</tr>"); continue; } else if (inTable) { out.push("</table>"); inTable = false; }
    if (/^\s*[-*] /.test(ln)) { if (!inList) { out.push("<ul>"); inList = true; } out.push("<li>" + inline(ln.replace(/^\s*[-*] /, "")) + "</li>"); continue; } else if (inList) { out.push("</ul>"); inList = false; }
    const h = ln.match(/^(#{1,4})\s+(.*)/); if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (!ln.trim()) { out.push(""); continue; }
    out.push("<p>" + inline(ln) + "</p>");
  }
  if (inList) out.push("</ul>"); if (inTable) out.push("</table>");
  return `<!doctype html><meta charset="utf-8"><style>body{font:14px/1.5 "Segoe UI",Arial,sans-serif;color:#1a1a1a;max-width:900px;margin:32px auto;padding:0 24px}h1{font-size:26px}h2{font-size:20px;margin-top:28px}code,pre{font-family:Consolas,monospace;font-size:12.5px;background:#f2f3f5;padding:1px 4px;border-radius:3px}pre{padding:10px;overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}td{border-bottom:1px solid #ddd;padding:6px 8px;vertical-align:top}</style><body>${out.join("\n")}</body>`;
};
(async () => {
  const { chromium } = require("playwright");
  const browser = await chromium.launch(); const page = await browser.newPage({ colorScheme: "light" });
  for (const f of files) {
    const src = path.resolve(ROOT, f); const ext = path.extname(src).toLowerCase();
    let html = fs.readFileSync(src, "utf8"); if (ext === ".md") html = mdToHtml(html);
    else if (!/<html|<!doctype/i.test(html.slice(0, 300))) html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:14px system-ui,sans-serif;background:#fff;color:#111}img{max-width:100%}</style></head><body>${html}</body></html>`;
    await page.setContent(html, { waitUntil: "load" }); try { await page.waitForTimeout(600); } catch {}
    const out = path.join(outDir, path.basename(src).replace(/\.(html|md)$/i, "") + ".pdf");
    await page.emulateMedia({ media: "print" });
    await page.pdf({ path: out, format: "Letter", printBackground: true, preferCSSPageSize: true, margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" } });   // a page's own @page rule (e.g. landscape) wins
    await page.emulateMedia({ media: "screen" });
    console.log(out);
  }
  await browser.close();
})().catch((e) => { console.error("pdf failed:", e.message); process.exit(1); });
