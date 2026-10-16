#!/usr/bin/env node
/**
 * ENV NAMES — which NAMES of an env file would the adapter hand to a model CLI? 2026-10-11 (docs/server/wave6-agents/test).
 * READ-ONLY, NAMES ONLY: the file's values are never printed, kept or compared (each name is tried with the letter x as its value).
 * It answers one question of the 2026-10-11 review: if a calling process had loaded backend/.env before it called the adapter, what
 * would reach the model CLI's environment — under the old rule (every name that is not credential-shaped) and under the rule in force
 * (an allow-list, the provider's own names, and the old rule as the second check).
 *
 *   node docs/server/wave6-agents/test/env-names.cjs [<env file>]      default: backend/.env of this tree
 * Exit 0 nothing but a provider's own credential names would be handed over · 1 another name would · 2 the file cannot be read.
 */
"use strict";
const fs = require("fs"), path = require("path");
const REPO = path.resolve(__dirname, "..", "..", "..", ".."), AC = require(path.join(REPO, "backend", "lib", "agent-cli.js"));
const file = process.argv[2] ? path.resolve(process.argv[2]) : path.join(REPO, "backend", ".env");
let text; try { text = fs.readFileSync(file, "utf8"); } catch (e) { console.log(`cannot read ${file}: ${e.code || e.message}`); process.exit(2); }
const names = [...new Set(text.split(/\r?\n/).map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)).filter(Boolean).map((m) => m[1]))];
text = null;
const asEnv = Object.fromEntries(names.map((n) => [n, "x"])), oldPassed = names.filter((n) => !AC.envDenied(n));
console.log(`${names.length} names in ${path.relative(REPO, file) || file} (names only; no value is read out)`);
console.log(`old rule — everything that is not credential-shaped: ${names.length - oldPassed.length} dropped, ${oldPassed.length} would be handed to a model CLI: ${oldPassed.join(", ") || "none"}`);
let other = 0;
for (const p of AC.PROVIDER_NAMES) {
  const got = Object.keys(AC.childEnv(AC.PROVIDERS[p], asEnv).env), own = Object.keys(AC.PROVIDERS[p].env), mine = got.filter((n) => own.includes(n)), rest = got.filter((n) => !own.includes(n));
  other += rest.length;
  console.log(`rule in force, ${p}: ${rest.length} other name(s) handed over${rest.length ? " — " + rest.join(", ") : ""}; its own credential name(s): ${mine.join(", ") || "none in this file"}`);
}
console.log(other ? `${other} name(s) beyond the providers' own would be handed over` : "nothing but a provider's own credential names would be handed over");
process.exitCode = other ? 1 : 0;
