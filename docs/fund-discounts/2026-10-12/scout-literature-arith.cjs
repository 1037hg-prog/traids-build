#!/usr/bin/env node
// scout-literature-arith.cjs — the arithmetic behind docs/fund-discounts/2026-10-12/scout-literature.md
//
// It reads NO market data and makes NO network request. Every input is a number PUBLISHED by someone
// else (cited in scout-literature.md, section "Sources"); this file only converts units so that each
// figure in the note can be re-run:  node docs/fund-discounts/2026-10-12/scout-literature-arith.cjs
//
// Nothing here is a house result. Nothing here is an outcome of any TRAIDS data.
'use strict';

const r2 = (x) => Math.round(x * 100) / 100;
const r0 = (x) => Math.round(x);
const perMonth = (annualPct) => annualPct / 12;

// ---- published inputs -------------------------------------------------------------------------
const published = {
  thompson1978: { label: 'Thompson 1978, discount-weighted, 1940-75, abnormal %/yr (via Dimson & Minio-Paluello 2002, Table 5)', annualPct: 4.12 },
  thompson1978eq: { label: 'Thompson 1978, discount funds equal-weighted, abnormal %/yr (same table)', annualPct: 2.37 },
  pontiff1995: { label: 'Pontiff 1995, 20% discount vs none, expected 12-month return gap %', annualPct: 6.0, discountPts: 20 },
  patroNaiveLS: { label: 'Patro-Piccotti-Wu 2014 WP, naive lowest-minus-highest premium quintile, 1998-2011, gross %/yr', annualPct: 14.9 },
  patroNaiveLongMinusMkt: { label: 'same paper, naive long quintile minus market, gross %/yr', annualPct: 9.3 },
  patroRadfLS: { label: 'same paper, RADF model long-short, gross %/yr', annualPct: 18.2 },
  patroRadfLongMinusMkt: { label: 'same paper, RADF long quintile minus market, gross %/yr', annualPct: 10.7 },
};
const cost = {
  cssOneWayPct: { muni: 0.40, taxableFI: 0.54, domEquity: 0.51, forEquity: 0.68 }, // Cherkes-Sagi-Stanton 2009, Table 2 panel c, 1986-2004
  patroAuthorsSpreadPct: 0.67,                                                   // authors' e-mail estimate, reported by CXO Advisory 2014
  r313RoundTripPct: 0.06,                                                        // the house's own registered cost for R313 (liquid ETFs)
};
const liquidity = {
  patroMeanAnnualDollarVolume: 223.706e6, // per fund, benchmark portfolio, 1998-2011 (Patro et al., Table V text)
  guggenheimFloorPerDay: 400000,          // median daily $ volume over prior 30 trading days (Guggenheim UIT screen)
};
const turnoverPerYear = 2.335;            // Patro et al.: the naive long-short portfolio's annualised turnover
const mcleanPontiffPostPublicationHaircut = 0.58; // McLean & Pontiff 2016: average across 97 stock predictors, NOT closed-end-fund specific
const account = 100000;

// ---- 1. published premiums in per-month units ---------------------------------------------------
console.log('1. Published premiums, converted to % per month (simple /12)');
for (const k of Object.keys(published)) {
  const p = published[k];
  console.log('   ' + r2(perMonth(p.annualPct)).toFixed(2) + '%/mo  <- ' + p.annualPct + '%/yr  ' + p.label);
}
const pontiffPerPoint = published.pontiff1995.annualPct / published.pontiff1995.discountPts;
console.log('   Pontiff per point of discount: ' + r2(pontiffPerPoint) + '%/yr = ' + r2(perMonth(pontiffPerPoint) * 100) + ' basis points per month per point');

// ---- 2. half-lives implied by published persistence --------------------------------------------
console.log('\n2. Half-lives implied by published persistence');
const hlPatro = Math.log(0.5) / Math.log(1 - 0.086);
console.log('   Patro et al.: bias-adjusted reversion 8.6%/month -> half-life ' + r2(hlPatro) + ' months (paper says 7.7)');
const hlMX = Math.log(0.5) / Math.log(0.98);
console.log('   Malkiel & Xu 2005: weekly autocorrelation 0.98 of the AGGREGATE discount -> half-life ' + r2(hlMX) + ' weeks = ' + r2(hlMX / (52 / 12)) + ' months');

// ---- 3. round-trip cost ---------------------------------------------------------------------------
console.log('\n3. Round-trip cost, % of price');
const rts = {};
for (const k of Object.keys(cost.cssOneWayPct)) { rts['CSS 2009 ' + k + ' (2 x one-way)'] = 2 * cost.cssOneWayPct[k]; }
rts['Patro authors (one full quoted spread)'] = cost.patroAuthorsSpreadPct;
for (const k of Object.keys(rts)) {
  console.log('   ' + r2(rts[k]).toFixed(2) + '%  ' + k + '   = ' + r0(rts[k] / cost.r313RoundTripPct) + 'x the R313 ETF round trip of ' + cost.r313RoundTripPct + '%');
}
const rtLow = cost.patroAuthorsSpreadPct, rtHigh = 2 * cost.cssOneWayPct.forEquity;

// ---- 4. months of published premium needed to pay one round trip --------------------------------
console.log('\n4. Months of the published premium needed just to pay one round trip (premium in %/mo; low cost ' + rtLow + '%, high cost ' + r2(rtHigh) + '%)');
for (const k of ['thompson1978', 'pontiff1995', 'patroNaiveLongMinusMkt']) {
  const pm = perMonth(published[k].annualPct);
  console.log('   ' + r2(rtLow / pm).toFixed(1) + ' to ' + r2(rtHigh / pm).toFixed(1) + ' months  at ' + r2(pm).toFixed(2) + '%/mo  (' + k + ')');
}

// ---- 5. size a $100,000 account could trade -------------------------------------------------------
console.log('\n5. Size for a $' + account.toLocaleString('en-US') + ' account');
const patroPerDay = liquidity.patroMeanAnnualDollarVolume / 252;
console.log('   Patro mean dollar volume per fund: $' + r0(patroPerDay).toLocaleString('en-US') + ' a day (annual $223.706M / 252)');
for (const n of [10, 20]) {
  const pos = account / n;
  console.log('   ' + n + ' equal positions of $' + pos.toLocaleString('en-US') + ': ' +
    r2(100 * pos / liquidity.guggenheimFloorPerDay) + '% of a day at the $400,000 floor, ' +
    r2(100 * pos / patroPerDay) + '% of a day at the Patro mean');
}
for (const capPct of [1, 5]) {
  console.log('   A cap of ' + capPct + '% of daily dollar volume allows $' + r0(liquidity.guggenheimFloorPerDay * capPct / 100).toLocaleString('en-US') +
    ' a day at the floor and $' + r0(patroPerDay * capPct / 100).toLocaleString('en-US') + ' a day at the Patro mean');
}

// ---- 6. dollars: cost per year and the published gross, labelled ---------------------------------
console.log('\n6. Dollars per year on $' + account.toLocaleString('en-US') + ' fully invested, at the published turnover of ' + turnoverPerYear + 'x a year');
const costLow = account * turnoverPerYear * rtLow / 100, costHigh = account * turnoverPerYear * rtHigh / 100;
console.log('   Trading cost: $' + r0(costLow).toLocaleString('en-US') + ' to $' + r0(costHigh).toLocaleString('en-US') + ' a year ($' + r0(costLow / 12) + ' to $' + r0(costHigh / 12) + ' a month)');
const gross = account * published.patroNaiveLongMinusMkt.annualPct / 100;
console.log('   PUBLISHED gross, long-only minus market, 1998-2011, other people\'s sample: $' + r0(gross).toLocaleString('en-US') + ' a year ($' + r0(gross / 12) + ' a month)');
console.log('   Same, net of the cost range above: $' + r0(gross - costHigh).toLocaleString('en-US') + ' to $' + r0(gross - costLow).toLocaleString('en-US') + ' a year');
const hair = gross * (1 - mcleanPontiffPostPublicationHaircut);
console.log('   ILLUSTRATION ONLY, with the average 58% post-publication haircut of McLean & Pontiff (not fund-specific): gross $' + r0(hair).toLocaleString('en-US') +
  ' a year; net $' + r0(hair - costHigh).toLocaleString('en-US') + ' to $' + r0(hair - costLow).toLocaleString('en-US') + ' a year = $' + r0((hair - costHigh) / 12) + ' to $' + r0((hair - costLow) / 12) + ' a month');
console.log('\nNone of section 6 is a house number or a forecast. It is unit conversion on published figures.');
