// EXAMPLE signal (reference shape only; not a registered test): a one-day cross-sectional reversal on eq-daily.
// Each day: rank yesterday-to-today returns of the listed names with a 20-day median volume above a floor; short the top decile,
// long the bottom decile, equal weight. Reads only lag >= 0. Deterministic.
module.exports = {
  meta: { lookbackDays: 21 },
  signal(ctx) {
    const rows = [];
    for (const i of ctx.universe()) {
      const c0 = ctx.close(i, 0), c1 = ctx.close(i, 1);
      if (!(c0 > 0 && c1 > 0)) continue;
      const v = ctx.history(i, "volume", 20).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
      if (v.length < 20 || v[10] * c0 < 5e6) continue;   // median dollar volume floor
      rows.push([i, c0 / c1 - 1]);
    }
    if (rows.length < 50) return [];
    rows.sort((a, b) => a[1] - b[1]);
    const k = Math.floor(rows.length / 10), out = [];
    for (let j = 0; j < k; j++) out.push([rows[j][0], 1]);
    for (let j = rows.length - k; j < rows.length; j++) out.push([rows[j][0], -1]);
    return out;
  },
};
