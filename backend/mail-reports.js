#!/usr/bin/env node
/**
 * mail-reports.js — email the operator a set of report files as attachments (operator inbox only, from backend/.env SMTP settings).
 *   node backend/mail-reports.js --subject "..." --body "..." file1 file2 ...
 * Paths are relative to the repo root. Uses the same Gmail App Password as notify.js. Nothing here is sent to anyone else.
 */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
for (const ln of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); }
const argv = process.argv.slice(2); const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const files = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--subject" && argv[i - 1] !== "--body");
const user = process.env.SMTP_USER, pass = (process.env.SMTP_PASS || "").replace(/\s+/g, ""), to = process.env.REPORT_EMAIL_TO;
if (!user || !pass || !to) { console.error("SMTP_USER / SMTP_PASS / REPORT_EMAIL_TO not set in backend/.env"); process.exit(1); }
const attachments = files.map((f) => { const p = path.resolve(ROOT, f); if (!fs.existsSync(p)) { console.error("missing:", f); process.exit(1); } return { filename: path.basename(p), path: p }; });
(async () => {
  const nodemailer = require("nodemailer");
  const t = nodemailer.createTransport({ host: process.env.SMTP_HOST || "smtp.gmail.com", port: +(process.env.SMTP_PORT || 465), secure: true, auth: { user, pass } });
  const info = await t.sendMail({ from: `"TRAIDS" <${user}>`, to, subject: opt("--subject", "TRAIDS reports"), text: opt("--body", "Attached."), attachments });
  console.log("sent", info.messageId, "|", attachments.map((a) => a.filename).join(", "));
})().catch((e) => { console.error("mail failed:", e.message); process.exit(1); });
