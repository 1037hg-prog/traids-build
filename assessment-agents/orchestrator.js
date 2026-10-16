/**
 * Orchestrator — runs the full panel (each ROLE × each enabled PROVIDER), parses
 * the JSON verdicts, and AGGREGATES them. The headline output is not just a verdict
 * but the CROSS-MODEL DISAGREEMENT: where different models split, that's the honest
 * flag for human review (correlated same-model "agents" can't give you this).
 *
 * Every assessment is appended to data/assessment-trail.jsonl — the documented,
 * timestamped, repeatable audit trail (the compliance-grade artifact).
 */
const fs = require("fs"), path = require("path");
const { enabledProviders, ask } = require("./providers");
const { ROLES } = require("./roles");

const DATA = path.join(__dirname, "data");
const TRAIL = path.join(DATA, "assessment-trail.jsonl");
fs.mkdirSync(DATA, { recursive: true });

function extractJson(text) {
  if (!text) return null;
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}
const norm = v => { const s = String(v || "").toUpperCase(); if (s.includes("FAIL")) return "FAIL"; if (s.includes("CONCERN")) return "CONCERNS"; if (s.includes("PASS")) return "PASS"; return "CONCERNS"; };

async function runPanel(input, opts = {}) {
  const providers = (opts.providers && opts.providers.length) ? opts.providers : enabledProviders();
  if (!providers.length) throw new Error("No LLM providers configured — set at least one API key (or OLLAMA_MODEL) in .env.");
  // opts.roleSet lets a caller swap the whole panel (e.g. REPAIR_ROLES for an instrument fix,
  // which the edge panel auto-FAILs by construction — see roles.js). opts.roles still filters by id.
  const baseRoles = (Array.isArray(opts.roleSet) && opts.roleSet.length) ? opts.roleSet : ROLES;
  const roles = (opts.roles && opts.roles.length) ? baseRoles.filter(r => opts.roles.includes(r.id)) : baseRoles;
  const userPrompt = `Assess the following TRAIDS item. Be concrete and quantitative.\n\n${typeof input === "string" ? input : JSON.stringify(input, null, 2)}`;

  // fan out every role × provider
  const calls = [];
  for (const role of roles) for (const prov of providers) calls.push({ role, prov });
  const results = await Promise.all(calls.map(async ({ role, prov }) => {
    const res = await ask(prov, role.systemPrompt, userPrompt);
    const parsed = res.ok ? extractJson(res.text) : null;
    return {
      role: role.id, provider: prov, model: res.model,
      ok: res.ok && !!parsed,
      verdict: parsed ? norm(parsed.verdict) : null,
      confidence: typeof parsed?.confidence === "number" ? parsed.confidence : null,
      key_risks: Array.isArray(parsed?.key_risks) ? parsed.key_risks.slice(0, 6) : [],
      rationale: parsed?.rationale || (res.ok ? "(unparseable response)" : res.error),
    };
  }));

  // aggregate per role: do the providers agree?
  const byRole = {};
  for (const r of results) (byRole[r.role] ||= []).push(r);
  const role_summary = Object.entries(byRole).map(([role, rs]) => {
    const verdicts = rs.filter(r => r.verdict).map(r => r.verdict);
    const counts = verdicts.reduce((m, v) => (m[v] = (m[v] || 0) + 1, m), {});
    const responded = verdicts.length;
    const verdict = responded === 0 ? "NO_RESPONSE"
      : verdicts.includes("FAIL") ? "FAIL"
      : verdicts.includes("CONCERNS") ? "CONCERNS" : "PASS";
    return {
      role, responded: responded + "/" + rs.length, verdicts: counts,
      consensus: responded > 0 && Object.keys(counts).length === 1,
      disagreement: responded >= 2 && Object.keys(counts).length > 1,   // a REAL cross-model split needs >=2 responses
      verdict, risks: [...new Set(rs.flatMap(r => r.key_risks))].slice(0, 8),
    };
  });

  // CRITICAL: a role that didn't answer must NEVER push the overall toward PASS. Require a
  // quorum of roles to actually respond; otherwise the verdict is INCONCLUSIVE, not PASS.
  const responding = role_summary.filter(r => r.verdict !== "NO_RESPONSE");
  const quorum = responding.length >= Math.ceil(role_summary.length / 2);
  const anyFail = responding.some(r => r.verdict === "FAIL");
  const anyConcern = responding.some(r => r.verdict === "CONCERNS");
  const anyPass = responding.some(r => r.verdict === "PASS");
  const overall = !quorum ? "INCONCLUSIVE"
    : anyFail ? "FAIL" : anyConcern ? "CONCERNS" : anyPass ? "PASS" : "INCONCLUSIVE";
  const cross_model_disagreement = role_summary.filter(r => r.disagreement).map(r => r.role);
  const no_response_roles = role_summary.filter(r => r.verdict === "NO_RESPONSE").map(r => r.role);

  const record = {
    ts: new Date().toISOString(),
    overall,                                  // FAIL > CONCERNS > PASS; INCONCLUSIVE if too few roles answered
    cross_model_disagreement,                 // ← the honest signal: where models split
    no_response_roles,                        // roles whose model output didn't parse (don't trust a verdict missing these)
    note: "Risk-check & documentation only. This panel does NOT generate edge.",
    providers, roles: roles.map(r => r.id),
    role_summary,
    raw: results,
    input,
  };
  fs.appendFileSync(TRAIL, JSON.stringify(record) + "\n");
  return record;
}

module.exports = { runPanel, TRAIL };
