"use strict";
/**
 * THE SLEEVE PACKAGE'S OWN JUDGE, READ-ONLY (pause-switches package, 2026-10-12). Prints one line "@@JUDGE <json>":
 *   plan        docs/server/wave3-sleeves/home-patch.cjs stateOf of each of its entries: [[state, rel, why]]
 *   pin         the sha256 that package pins for backend/r236-tv-forward.js
 *   baseSha     the sha256 its own engine computes for home's runner with that package's own three lines read out (must equal pin)
 *   stagedSame  apply(base) = its staged copy, byte for byte (what its `--stage` would write)
 *   switches    cell.cjs UNITS["w3-r236"].switches, and every unit's switches
 * It loads that package's files and writes nothing. Run under harness/overlay.cjs it judges the STAGED text; run plainly, the live files.
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const REPO = path.resolve(__dirname, "..", "..", "..", ".."), W3 = path.join(REPO, "docs", "server", "wave3-sleeves");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const HP = require(path.join(W3, "home-patch.cjs")), C = require(path.join(W3, "cell.cjs"));
const ent = HP.EDITS.find((e) => e.rel === "backend/r236-tv-forward.js");
let baseSha = null, stagedSame = null, err = null;
try { const b = HP.baseText(ent); baseSha = sha(Buffer.from(b, "utf8")); stagedSame = Buffer.from(HP.applyText(ent, b), "utf8").equals(fs.readFileSync(ent.staged)); } catch (e) { err = String(e.message).slice(0, 200); }
const plan = HP.ALL().map((e) => { let s; try { s = HP.stateOf(e); } catch (x) { s = { state: "error", why: String(x.message).slice(0, 200) }; } return [s.state, e.rel, s.why || null]; });
console.log("@@JUDGE " + JSON.stringify({ plan, pin: ent.pin, baseSha, stagedSame, err, switches: C.UNITS["w3-r236"].switches, allSwitches: Object.fromEntries(C.UNIT_IDS.map((u) => [u, C.UNITS[u].switches])), overlay: globalThis.__PAUSE_SWITCHES_OVERLAY || 0 }));
