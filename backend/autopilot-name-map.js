/**
 * 13F issuer-name → ticker matching, shared by autopilot-eval.js (historical clones) and
 * autopilot-cohort.js (forward truth cohort). Built from the app's own SP500 universe plus
 * explicit aliases for the names these funds actually hold. A failed match returns null and
 * the caller REPORTS it — coverage is always printed, never silently absorbed.
 */
const fs = require("fs"), path = require("path");

function norm(s) {
  return String(s).toUpperCase()
    .replace(/\b(INC|CORP|CO|LTD|PLC|CL A|CL B|CL C|CLASS A|CLASS B|COM|NEW|DEL|ADR|SPONSORED|HLDGS?|HOLDINGS?|GRP|GROUP|&)\b/g, "")
    .replace(/[^A-Z ]/g, "").replace(/\s+/g, " ").trim();
}

function buildNameMap() {
  const map = {};
  try {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "App.jsx"), "utf8");
    const re = /sym:\s*"([A-Z.]+)"\s*,\s*name:\s*"([^"]+)"/g; let m;
    while ((m = re.exec(src))) map[norm(m[2])] = m[1];
  } catch { }
  const extra = { "META PLATFORMS": "META", "ALPHABET": "GOOGL", "AMAZON COM": "AMZN", "APPLE": "AAPL", "MICROSOFT": "MSFT", "NVIDIA": "NVDA", "BERKSHIRE HATHAWAY": "BRK.B", "TAIWAN SEMICONDUCTOR": "TSM", "ALIBABA GROUP": "BABA", "JD COM": "JD", "BAIDU": "BIDU", "NOVO NORDISK": "NVO", "COHERENT": "COHR", "TERADYNE": "TER", "CHARTER COMMUNICATIONS": "CHTR", "OCCIDENTAL PETE": "OXY", "OCCIDENTAL PETROLEUM": "OXY", "CHEVRON": "CVX", "COCA COLA": "KO", "BANK AMER": "BAC", "BANK OF AMERICA": "BAC", "AMERICAN EXPRESS": "AXP", "KRAFT HEINZ": "KHC", "MOODYS": "MCO", "CHUBB": "CB", "CITIGROUP": "C", "ESTEE LAUDER": "EL", "GEO GROUP": "GEO", "STELLANTIS": "STLA", "MOLINA HEALTHCARE": "MOH", "HCA HEALTHCARE": "HCA", "BRUKER": "BRKR", "PDD HLDGS": "PDD", "PDD HOLDINGS": "PDD", "COUPANG": "CPNG", "TEVA PHARMACEUTICAL": "TEVA", "NATERA": "NTRA", "SEAGATE TECHNOLOGY": "STX", "PALO ALTO NETWORKS": "PANW", "VERTIV": "VRT", "VISTRA": "VST", "TALEN ENERGY": "TLN", "PHILIP MORRIS": "PM", "TECK RESOURCES": "TECK", "FREEPORT MCMORAN": "FCX", "ARISTA NETWORKS": "ANET", "MICRON TECHNOLOGY": "MU", "BROADCOM": "AVGO", "ADV MICRO DEVICES": "AMD", "ADVANCED MICRO DEVICES": "AMD", "NETFLIX": "NFLX", "TESLA": "TSLA", "UNITEDHEALTH GROUP": "UNH", "UBER TECHNOLOGIES": "UBER", "GILEAD SCIENCES": "GILD", "ASTRAZENECA": "AZN", "ELI LILLY": "LLY", "JPMORGAN CHASE": "JPM", "TEMPUS AI": "TEM", "SEA LTD": "SE", "CAMECO": "CCJ", "KRATOS DEFENSE": "KTOS", "AEROVIRONMENT": "AVAV", "LEIDOS": "LDOS", "BOOZ ALLEN": "BAH", "CACI INTL": "CACI", "CACI INTERNATIONAL": "CACI", "PALANTIR TECHNOLOGIES": "PLTR", "CROWDSTRIKE": "CRWD", "LULULEMON ATHLETICA": "LULU", "LULULEMON": "LULU", "SLM": "SLM", "MOLINA HEALTHCARE": "MOH" };
  for (const [k, v] of Object.entries(extra)) map[norm(k)] = v;
  return map;
}

function matchTicker(issuer, map) {
  const n = norm(issuer);
  if (map[n]) return map[n];
  for (const [k, v] of Object.entries(map))
    if (k && (n.startsWith(k) || k.startsWith(n)) && Math.min(k.length, n.length) >= 5) return v;
  return null;
}

module.exports = { buildNameMap, matchTicker, norm };
