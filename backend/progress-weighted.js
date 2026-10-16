/**
 * WHERE THE WEIGHTED BOARD SITS. (2026-09-09, operator: "add where the weighted board sits")
 *
 * The weighted board is the layer that decides how much each observer feature counts when a ticket is
 * scored. It screens 97 candidate contributors across the clean epoch and lets the ones that look
 * predictive carry weight. So "where it sits" is really one question: ARE THE FEATURES CARRYING
 * WEIGHT DISTINGUISHABLE FROM NOISE?
 *
 * The file answers that itself, and the answer is the reason this section exists rather than a table
 * of weights. Two numbers do all the work:
 *
 *   earningAtRegisteredScreen   how many contributors currently carry weight
 *   expectedNoiseCrossings      how many would carry weight if every feature were pure noise
 *
 * When those two are the same number, the weighting layer is not finding signal — it is finding the
 * number of false positives you get for free when you screen 97 things at a two-sigma threshold. The
 * board also computes an HONEST two-sided best-of-K bar per contributor, which is what a screen of
 * that width actually owes, and reports how many clear it.
 *
 * IN-SAMPLE, AND THE FILE SAYS SO. Weights are measured on the full clean epoch, so they are fitted
 * on the same data they are scored against. The live board is supposed to recompute walk-forward
 * using only sessions closed before the ticket being scored; until it does, these weights are an
 * upper bound on what the layer can contribute, not a measurement of what it did contribute. That
 * caveat travels with the numbers here rather than living in a file nobody opens.
 */
const fs = require("fs"), path = require("path");

function build() {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "weighted-board.json"), "utf8")); }
  catch { return { html: "", line: null }; }

  const hs = j.honestScreen || {};
  const earning = (hs.earningAtRegisteredScreen || []).length;
  const expected = hs.expectedNoiseCrossingsAtRegisteredScreen;
  const clearing = (hs.clearingHonestBar || []).length;
  const per = hs.perContributor || [];
  const n2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "—");
  const red = "#b42318", grn = "#1a7f37";

  // the strongest contributors, each against ITS OWN multiplicity-corrected bar
  const top = [...per].sort((a, b) => Math.abs(b.t || 0) - Math.abs(a.t || 0)).slice(0, 6).map((c) => `
    <tr><td class="k">${c.id}</td>
        <td class="n">${c.sessions}</td>
        <td class="n">${n2(c.t)}</td>
        <td class="n">${n2(c.bar)}</td>
        <td class="n" style="font-weight:600;color:${c.clears ? grn : red}">${c.clears ? "clears" : "no"}</td></tr>`).join("");

  const verdict = clearing === 0 && Number.isFinite(expected) && earning <= expected
    ? `<b style="color:${red}">The weighting layer is currently indistinguishable from noise.</b> ${earning} contributors carry weight; screening ${hs.contributorsScreened} features at the registered threshold would produce about <b>${n2(expected)}</b> by chance alone. Zero clear the honest bar that a screen of that width owes.`
    : clearing === 0
      ? `<b style="color:${red}">No contributor clears its honest bar.</b> ${earning} carry weight at the registered screen, but the multiplicity-corrected threshold for a ${hs.contributorsScreened}-feature search is met by none of them.`
      : `<b style="color:${grn}">${clearing} contributor(s) clear the honest multiplicity-corrected bar</b> out of ${hs.contributorsScreened} screened.`;

  const html = `
  <h2><span>Weighted board</span>Where the scoring layer sits</h2>
  <p class="sub">The weighted board decides how much each observer feature counts when a ticket is scored. The question that
  matters is not which features carry weight — it is whether the ones carrying weight are distinguishable from the false
  positives you get free when you screen ${hs.contributorsScreened} things at once.</p>
  <div class="tablewrap"><table>
    <tr><td class="k">Contributors screened</td><td class="n">${hs.contributorsScreened}</td><td class="note">across ${j.trades} trades / ${j.sessions} sessions</td></tr>
    <tr><td class="k">Carrying weight now</td><td class="n">${earning}</td><td class="note">${(hs.earningAtRegisteredScreen || []).join(", ") || "none"}</td></tr>
    <tr><td class="k">Expected from pure noise</td><td class="n" style="font-weight:600">${n2(expected)}</td><td class="note">how many would cross the registered screen if every feature were random</td></tr>
    <tr><td class="k">Clearing the HONEST bar</td><td class="n" style="font-weight:600;color:${clearing ? grn : red}">${clearing}</td><td class="note">${hs.rule || "two-sided best-of-K correction for the width of the search"}</td></tr>
    <tr><td class="k">Total absolute weight</td><td class="n">${j.totalAbsWeight}</td><td class="note">${j.conviction || ""}</td></tr>
  </table></div>
  <p class="sub">${verdict}</p>
  <div class="tablewrap"><table>
    <tr><td class="k">Strongest contributors</td><td class="n">sessions</td><td class="n">t</td><td class="n">its own bar</td><td class="n">verdict</td></tr>
    ${top}
  </table></div>
  <p class="sub">Each contributor is shown against <b>its own</b> multiplicity-corrected bar, not a common one — a feature
  measured on 6 sessions owes a wider bar than one measured on 32. <i>These weights are fitted on the full clean epoch, so
  they are in-sample: the live board must recompute them walk-forward, using only sessions closed before the ticket being
  scored, or the layer scores itself. Until that lands, treat this as an upper bound on what weighting could contribute,
  not a measurement of what it did.</i></p>`;

  const line = `Weighted board: ${earning} of ${hs.contributorsScreened} contributors carry weight, ~${n2(expected)} expected from noise, ${clearing} clear the honest bar.`;
  return { html, line };
}

module.exports = { build };
