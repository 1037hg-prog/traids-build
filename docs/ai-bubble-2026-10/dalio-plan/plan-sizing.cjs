// plan-sizing.cjs - arithmetic for the AI-bubble contingency plan. Inputs are the 10-07 measurement outputs
// (paper-exposure.out.txt, core-exposure.out.txt, crypto-vs-nasdaq.out.txt, run-now.txt, zn-results.json), typed in below.
const f = (x) => "$" + Math.round(x).toLocaleString("en-US");
const p = (x, d = 1) => (x * 100).toFixed(d) + "%";
const L = (s) => console.log(s);
// paper books (classify.js look-through)
const eqAll = 299128, hwAll = 70912, mcAll = 16370, cryAll = 36708;
const aiAll = hwAll + mcAll;
L(`paper AI total   = ${f(hwAll)} + ${f(mcAll)} = ${f(aiAll)} = ${p(aiAll / eqAll)} of ${f(eqAll)}`);
L(`paper per -10% AI= 0.10 x ${f(aiAll)} = ${f(0.1 * aiAll)} = ${p(0.1 * aiAll / eqAll, 2)} of equity`);
const acct = { main: [101556, 13201, 904, 30224], book: [100653, 13948, 14407, 0], tv: [96918, 43763, 1059, 6485] };
for (const [k, [e, h, m, c]] of Object.entries(acct)) L(`${k.padEnd(5)} AI = ${f(h)} + ${f(m)} = ${f(h + m)} (${p((h + m) / e)}); per -10% AI ${f(0.1 * (h + m))}; crypto ${f(c)}`);
const planE = 73584, planEai = 0.251, r24 = 25269, r24ai = 0.391;
L(`Plan E AI        = ${p(planEai)} x ${f(planE)} = ${f(planEai * planE)}; per -10% ${f(0.1 * planEai * planE)}`);
L(`R24 mirror AI    = ${p(r24ai)} x ${f(r24)} = ${f(r24ai * r24)}; per -10% ${f(0.1 * r24ai * r24)}`);
// crypto 2022 replay (QQQ 2021-12-27 -> 2022-11-03: BTC -60.2%, ETH -62.1%)
L(`crypto 2022 replay = ${f(cryAll)} x 60.2% = ${f(cryAll * 0.602)} .. x 62.1% = ${f(cryAll * 0.621)}; per -10% ${f(0.1 * cryAll)}`);
// board signal tickets
const brdLong = 3750 + 5000, brdOpt = 1986 + 405;
L(`board AI long    = $3,750 + $5,000 = ${f(brdLong)}; bullish AI option max-loss = $1,986 + $405 = ${f(brdOpt)}`);
// core: AI share of liquid assets under the four cases; per -10% fall in AI names
for (const [k, s] of [["A", 0.030], ["B", 0.193], ["C", 0.438], ["D", 0.609]]) L(`core ${k}: AI ${p(s)} -> per -10% AI names = ${p(0.1 * s, 2)} of liquid assets`);
// tripwire: QQQ 200d -2% band, from SMA/P-1 = -12.0% (run-now.txt, SMA held fixed)
for (const [k, d] of [["QQQ", -0.120], ["SPY", -0.078], ["SMH", -0.206]]) L(`${k} 200d band exit = 0.98 x (1 ${d}) - 1 = ${p(0.98 * (1 + d) - 1)} from 10-06 close`);
// ZN on $25k
const acctZ = 25000;
for (const [k, d] of [["stop 2.5 pts", 2500], ["worst 5-session +58bp", 4009], ["2022 worst +51bp", 3544]]) L(`ZN ${k.padEnd(22)} = ${f(d)} = ${p(d / acctZ)} of ${f(acctZ)}`);
L(`ZN leverage      = 104,500 / 25,000 = ${(104500 / 25000).toFixed(2)}x`);
