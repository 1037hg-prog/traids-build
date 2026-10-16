/**
 * R15 IN THE NIGHTLY REPORT — the one registered PASS, shown with its trades. (2026-09-09)
 *
 * Operator asked for R15's trades denoted in the progress report. Worth stating plainly what is and
 * is not being shown, because R15 is the only test on this board that has ever passed a bar, and a
 * "PASS" in a nightly money report will be read as a win unless it says otherwise.
 *
 * WHAT R15 IS. A KNOWN-ANSWER CALIBRATION, not a strategy. It replicates the option-income ETF rule
 * on real listed contracts — hold the index, sell the ATM call nearest 30 days, hold to expiry,
 * settle intrinsic, re-strike, no discretion and no strike shopping — and checks the replication's
 * CAGR against the fund's ACTUAL published CAGR. The bar is agreement within +/-1.0%/yr. Passing
 * means our options pipeline prices real contracts accurately enough to be trusted for index-option
 * work. It says nothing about whether the rule makes money.
 *
 * AND THE RULE IT VALIDATES LOST TO BUY-AND-HOLD. Over the same 2.49 years the replication returned
 * 13.52%/yr against SPY's 21.54% — eight points a year behind simply owning the index. That number
 * travels with the PASS everywhere it is quoted, because a certified-accurate measurement of a
 * losing rule is exactly what this is.
 *
 * TARGET SUBSTITUTION, DISCLOSED. The registered rule named QYLD; the run used XYLD because SPXW
 * contracts are available and NDX ones are not. That substitution is recorded in the artifact and is
 * repeated here rather than left in a file nobody opens.
 *
 * NOT FORWARD EVIDENCE. These 26 cycles are a historical replication over a fixed window, measured
 * once on 2026-08-03. They do not accrue nightly and nothing about them changes day to day — so this
 * section is a standing fact, not a scoreboard, and it is rendered that way.
 */
const fs = require("fs"), path = require("path");

function build() {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "r15-overwrite.json"), "utf8")); }
  catch { return { html: "", line: null }; }

  const priced = (j.rows || []).filter((r) => !r.note && Number.isFinite(r.cycleRet));
  const skipped = (j.rows || []).filter((r) => r.note);
  if (!priced.length) return { html: "", line: null };

  const n2 = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(2) : "—");
  const wins = priced.filter((r) => r.cycleRet > 0).length;
  const behind = (j.spyCagr != null && j.replicationCagr != null) ? j.spyCagr - j.replicationCagr : null;

  // the last dozen cycles, newest first — the whole set is 26 and the table is for reading, not auditing
  const rows = priced.slice(-12).reverse().map((r) => `
    <tr><td class="k">${r.entry} → ${r.exp}</td>
        <td class="n">${r.K}</td>
        <td class="n">${n2(r.premPct)}%</td>
        <td class="n">${n2(r.idxRet)}%</td>
        <td class="n" style="font-weight:600;color:${r.cycleRet >= 0 ? "#1a7f37" : "#b42318"}">${n2(r.cycleRet)}%</td></tr>`).join("");

  const html = `
  <h2><span>R15</span>The one registered PASS — and what it actually says</h2>
  <p class="sub"><b>R15 is a known-answer calibration, not a strategy.</b> It replicates the option-income ETF rule on real
  listed contracts (hold the index, sell the ATM call nearest 30 days, hold to expiry, re-strike — no discretion) and checks
  the result against the fund's own published record. Passing means <i>our options pipeline prices real contracts accurately</i>.
  It does not mean the rule makes money.</p>
  <div class="tablewrap"><table>
    <tr><td class="k">Replication CAGR</td><td class="n">${j.replicationCagr}%</td><td class="note">${j.cyclesPriced} cycles priced over ${j.years} years · ${skipped.length} skipped (no contract bar)</td></tr>
    <tr><td class="k">${j.target ? String(j.target).split(" ")[0] : "Fund"} actual CAGR</td><td class="n">${j.xyldActualCagr}%</td><td class="note">the known answer the replication had to hit</td></tr>
    <tr><td class="k">Replication error</td><td class="n" style="font-weight:600">${n2(j.replicationError)}%/yr</td><td class="note">bar was ±1.00%/yr → <b>PASS</b>. This is the whole finding.</td></tr>
    <tr><td class="k">SPY, same window</td><td class="n" style="color:#b42318">${j.spyCagr}%</td><td class="note">${behind == null ? "" : `the validated rule finished <b>${behind.toFixed(2)} points a year BEHIND simply owning the index</b>`}</td></tr>
    <tr><td class="k">Cycle win rate</td><td class="n">${((100 * wins) / priced.length).toFixed(0)}%</td><td class="note">${wins} of ${priced.length} monthly cycles positive</td></tr>
  </table></div>
  <p class="sub">Target substitution, disclosed: the registered rule named QYLD; the run used <b>${j.target}</b>. Measured once on
  ${String(j.ranAt).slice(0, 10)} over a fixed historical window — these cycles do not accrue nightly, so this section is a standing
  fact rather than a scoreboard.</p>
  <div class="tablewrap"><table>
    <tr><td class="k">Cycle (entry → expiry)</td><td class="n">Strike</td><td class="n">Premium</td><td class="n">Index</td><td class="n">Cycle</td></tr>
    ${rows}
  </table></div>
  <p class="sub">Last 12 of ${priced.length} cycles, newest first. <b>Premium</b> is the call sold as a % of index; <b>Index</b> is the
  index move over the cycle; <b>Cycle</b> is what the covered position actually returned — capped above the strike, unprotected below.
  That asymmetry is why the rule trails the index it is written on.</p>`;

  const line = `R15 (the one PASS): pipeline error ${n2(j.replicationError)}%/yr vs a ±1.00% bar — a calibration, not an edge; the rule it validates trailed SPY by ${behind == null ? "?" : behind.toFixed(1)} pts/yr.`;
  return { html, line };
}

module.exports = { build };
