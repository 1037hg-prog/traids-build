// Opens the Schwab authorize page in the default browser, then watches the clipboard (10 min max) for a NEW
// https://127.0.0.1/?code=... URL and hands it straight to backend/schwab-auth.js. Prints no key, code or token.
const fs = require("fs"), { spawn, execFileSync } = require("child_process");
const ROOT = "C:/Users/joshc/Downloads/traids (2)/traids-bundle";
const env = Object.fromEntries(fs.readFileSync(ROOT + "/backend/.env", "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const authUrl = `https://api.schwabapi.com/v1/oauth/authorize?response_type=code&client_id=${encodeURIComponent(env.SCHWAB_APP_KEY)}&redirect_uri=${encodeURIComponent("https://127.0.0.1")}`;
const clip = () => { try { return execFileSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard"], { encoding: "utf8", timeout: 5000 }).trim(); } catch { return ""; } };
const start = clip(); spawn("rundll32", ["url.dll,FileProtocolHandler", authUrl], { detached: true, stdio: "ignore" }).unref();
console.log("authorize page opened; watching the clipboard for a new 127.0.0.1 code URL (10 min)");
const t0 = Date.now();
const tick = () => {
  const c = clip();
  if (c && c !== start && /^https:\/\/127\.0\.0\.1\/?\?code=/.test(c)) {
    console.log("code URL seen on the clipboard — exchanging now");
    const p = spawn("node", ["backend/schwab-auth.js"], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.stdin.end(c + "\n");
    p.on("close", () => { for (const l of out.split(/\r?\n/)) if (/✔|failed|No \?code|missing/.test(l) && !/oauth\/authorize/.test(l)) console.log(l.replace(/"error_description":"(.{0,120}).*/, '"error_description":"$1'));
      const m = out.match(/Authorization code is[^\\"]*/); if (m) console.log(m[0]); });
    return;
  }
  if (Date.now() - t0 > 10 * 60000) { console.log("no code URL within 10 minutes — stopped"); return; }
  setTimeout(tick, 700);
};
tick();
