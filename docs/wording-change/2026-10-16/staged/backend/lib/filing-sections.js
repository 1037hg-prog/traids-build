"use strict";
/**
 * FILING SECTIONS — the PARSE LAYER of the wording-change collector (backlog row 25), 2026-10-16.
 *
 * It takes the SAVED TEXT of one 10-K or 10-Q, splits it into the standard items the form prescribes, and counts words. It makes no
 * network call, reads no file and reads no clock: every function here is pure, so the same bytes always give the same sections and
 * the same numbers. The fetch layer (backend/lib/sec-fetch.js) is what talks to EDGAR; this file never does.
 *
 *   splitSections(rawText, { form })      -> { form, sections: [...], found: [ids], warnings: [...] }
 *   sectionTexts(result)                  -> { <id>: <body text> }
 *   normalizeText(raw)                    -> plain text (HTML/SGML stripped when the bytes look like markup)
 *   tokenize(text) / countWords(text)     -> [words] / Map word -> count
 *   cosine(countsA, countsB)              -> 0..1, or null when either side has no words
 *
 * ── WHAT A SECTION IS ──────────────────────────────────────────────────────────────────────────────────────────────────────
 * A 10-K runs Item 1 … Item 16 in one sequence, so an item id alone names a section: "item1", "item1a", "item7a".
 * A 10-Q runs TWO sequences — Part I Items 1-4 (the financial statements, MD&A, market risk, controls) and Part II Items 1-6 (legal,
 * risk factors, equity sales, defaults, mine safety, other, exhibits) — and "Item 1" means a different thing in each, so a 10-Q id
 * carries its part: "p1item1" (Financial Statements) is not "p2item1" (Legal Proceedings).
 * A section's TEXT is everything after its heading line up to the next section's heading, with the heading's own standard title
 * removed: the titles are the same in every filing, so leaving them in would make two short sections look alike for no reason.
 *
 * ── HOW THE HEADINGS ARE CHOSEN (the table of contents problem) ────────────────────────────────────────────────────────────
 * Every item heading appears at least TWICE in a real filing: once in the table of contents at the front, once over the section
 * itself. Cross-references ("Item 1A. Risk Factors — see above.") add more. Picking the first match gives the table of contents and
 * therefore near-empty sections; picking the last match breaks on cross-references.
 *
 * So the candidates are all line-start "Item <n>" matches, and the sections are the CHAIN of them that
 *   (1) runs strictly forward through the document AND strictly forward through the form's item order — a chain can never go back
 *       to an earlier item, which is what rules a cross-reference out; then, among the chains that tie,
 *   (2) holds the MOST items — the table of contents and the body each list about the same items, but a chain cannot mix them (the
 *       body's Item 1 comes after the contents' Item 16, which is backwards), so the tie is between whole-contents and whole-body;
 *   (3) has the most EVIDENCE under its items. A heading's evidence is the text between it and the NEXT heading match of any kind —
 *       used by the chain or not — capped at EVIDENCE_CAP characters. Measuring it to the next match rather than to the next chosen
 *       section is the whole point: a contents entry is always followed closely by the next contents entry, so its evidence is the
 *       few characters of its own line, while a real section's evidence is its real text. Without that rule a chain could start at
 *       the contents' first entry and let it "swallow" the rest of the contents and the first real section, scoring higher than the
 *       body for covering more;
 *   (4) agrees most often with the PART headings seen on the way (10-Q only), then starts latest.
 * The one shape this does not recover is a filing whose BODY has lost a heading the contents still lists: the chain with the most
 * items then has to take that item, and every item before it, from the contents. Those sections come out with almost no words, and
 * `warnings` says which sections have no words — the collector records no score for them rather than a false one.
 * (4) is also why a 10-Q whose body never repeats "PART I" still parses: an ambiguous "Item 2" is offered as both p1item2 and
 * p2item2 and rule (2) keeps whichever one lets the chain hold more items; the part headings only break ties.
 *
 * Nothing here guesses: a filing whose items cannot be found comes back with an empty `sections` and a warning, and the collector
 * records that filing with no scores rather than inventing them.
 *
 * ── WHAT A WORD IS ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * Lower-case letter runs, apostrophes and hyphens kept inside a word ("company's", "well-known"). DIGITS ARE DROPPED: every filing
 * restates its dates and its amounts, so counting them would report a wording change for a company that only got a year older.
 * The score is the cosine of the two word-count vectors — 1 when the section was re-filed word for word (in any order), 0 when the
 * two share no word at all. Counts are raw: no stop-word list and no stemming, so the number is reproducible from the text alone.
 *
 *   node backend/lib/filing-sections.js --selftest
 */

// ── the standard items of each form, in the order the form prescribes ──────────────────────────────────────────────────────
const K_TITLES = Object.freeze({
  "1": "Business",
  "1A": "Risk Factors",
  "1B": "Unresolved Staff Comments",
  "1C": "Cybersecurity",
  "2": "Properties",
  "3": "Legal Proceedings",
  "4": "Mine Safety Disclosures",
  "5": "Market for Registrant's Common Equity, Related Stockholder Matters and Issuer Purchases of Equity Securities",
  "6": "Selected Financial Data",
  "7": "Management's Discussion and Analysis of Financial Condition and Results of Operations",
  "7A": "Quantitative and Qualitative Disclosures About Market Risk",
  "8": "Financial Statements and Supplementary Data",
  "9": "Changes in and Disagreements with Accountants on Accounting and Financial Disclosure",
  "9A": "Controls and Procedures",
  "9B": "Other Information",
  "9C": "Disclosure Regarding Foreign Jurisdictions that Prevent Inspections",
  "10": "Directors, Executive Officers and Corporate Governance",
  "11": "Executive Compensation",
  "12": "Security Ownership of Certain Beneficial Owners and Management and Related Stockholder Matters",
  "13": "Certain Relationships and Related Transactions, and Director Independence",
  "14": "Principal Accountant Fees and Services",
  "15": "Exhibits, Financial Statement Schedules",
  "16": "Form 10-K Summary",
});
/**
 * The order the FORM prescribes, written out. It is NOT Object.keys(K_TITLES): JavaScript lists an object's integer-like keys first,
 * in numeric order, and only then the rest in insertion order, so Object.keys would say Item 1A comes after Item 16 and every chain
 * through the items would be wrong (caught while building this, 2026-10-16).
 */
const K_ORDER = Object.freeze(["1", "1A", "1B", "1C", "2", "3", "4", "5", "6", "7", "7A", "8", "9", "9A", "9B", "9C", "10", "11", "12", "13", "14", "15", "16"]);
/** which part of the 10-K an item sits in — recorded for the reader, never used to choose a heading */
const K_PART = (item) => (K_ORDER.indexOf(item) <= K_ORDER.indexOf("4") ? 1 : K_ORDER.indexOf(item) <= K_ORDER.indexOf("9C") ? 2 : K_ORDER.indexOf(item) <= K_ORDER.indexOf("14") ? 3 : 4);

const Q_TITLES = Object.freeze({
  "1:1": "Financial Statements",
  "1:2": "Management's Discussion and Analysis of Financial Condition and Results of Operations",
  "1:3": "Quantitative and Qualitative Disclosures About Market Risk",
  "1:4": "Controls and Procedures",
  "2:1": "Legal Proceedings",
  "2:1A": "Risk Factors",
  "2:2": "Unregistered Sales of Equity Securities and Use of Proceeds",
  "2:3": "Defaults Upon Senior Securities",
  "2:4": "Mine Safety Disclosures",
  "2:5": "Other Information",
  "2:6": "Exhibits",
});
/** the order the form prescribes, written out for the same reason as K_ORDER */
const Q_ORDER = Object.freeze(["1:1", "1:2", "1:3", "1:4", "2:1", "2:1A", "2:2", "2:3", "2:4", "2:5", "2:6"]);

/** "10-K", "10-K/A", "10-KT" -> "10-K"; "10-Q", "10-Q/A" -> "10-Q"; anything else -> null (unsupported here) */
function baseForm(form) {
  const f = String(form || "").trim().toUpperCase();
  if (/^10-?K/.test(f)) return "10-K";
  if (/^10-?Q/.test(f)) return "10-Q";
  return null;
}
/** the id a section is stored under: 10-K "item1a"; 10-Q "p2item1a" */
const sectionId = (form, part, item) => (form === "10-Q" ? `p${part}item${item.toLowerCase()}` : `item${item.toLowerCase()}`);
const titleOf = (form, part, item) => (form === "10-Q" ? Q_TITLES[`${part}:${item}`] : K_TITLES[item]);

// ── text ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ENTITIES = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…", reg: "®", trade: "™", copy: "©", sect: "§", bull: "•" });
/** &amp; &#39; &#x27; &nbsp; … -> the character. An entity name this table does not know is left exactly as it was. */
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const k = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : whole;
  });
}
/** does this look like markup rather than plain text? (EDGAR serves 10-Ks as HTML, and the SGML wrapper has tags of its own) */
const looksLikeMarkup = (raw) => /<\/?(?:html|body|div|p|br|table|tr|td|th|span|font|b|i|u|ix:[a-z-]+|sec-document|type|text)\b[^>]*>/i.test(String(raw).slice(0, 200000));
/** markup -> plain text: scripts and styles go, block ends become newlines, every other tag goes, entities are decoded */
function htmlToText(raw) {
  let s = String(raw);
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<\s*(?:br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<\s*\/?\s*(?:p|div|tr|table|thead|tbody|li|ul|ol|h[1-6]|section|article|center|caption|blockquote|pre|dd|dt)\b[^>]*>/gi, "\n");
  s = s.replace(/<\s*\/?\s*(?:td|th)\b[^>]*>/gi, " ");
  s = s.replace(/<[^>]*>/g, "");
  s = decodeEntities(s);
  return s;
}
/**
 * The bytes as they will be read: markup stripped when there is markup, CRLF and non-breaking spaces made ordinary, runs of blank
 * lines cut to one, and trailing spaces dropped. Character OFFSETS below are offsets into THIS text, never into the raw bytes.
 */
function normalizeText(raw) {
  let s = looksLikeMarkup(raw) ? htmlToText(raw) : String(raw);
  s = s.replace(/\r\n?/g, "\n").replace(/[   \t]/g, " ").replace(/​/g, "");
  s = s.replace(/[ ]{2,}/g, " ").replace(/ +$/gm, "").replace(/^ +/gm, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim() + "\n";
}

const WORD_RE = /[a-z]+(?:['’-][a-z]+)*/g;
/** the words of a piece of text: lower-case letter runs; digits and punctuation are not words (see the header) */
function tokenize(text) {
  return String(text).toLowerCase().match(WORD_RE) || [];
}
/** word -> how many times it occurs */
function countWords(text) {
  const m = new Map();
  for (const w of tokenize(text)) m.set(w, (m.get(w) || 0) + 1);
  return m;
}
const totalWords = (counts) => { let n = 0; for (const v of counts.values()) n += v; return n; };
/**
 * The cosine of two word-count vectors: sum(a_w * b_w) / (|a| * |b|), over the words they share. 1 = the same words in the same
 * proportions, 0 = no shared word. null when either side has no words at all (nothing to compare — never 0, which would read as
 * "completely rewritten").
 */
function cosine(a, b) {
  if (!(a instanceof Map) || !(b instanceof Map) || a.size === 0 || b.size === 0) return null;
  let dot = 0, na = 0, nb = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [w, v] of small) { const u = big.get(w); if (u !== undefined) dot += v * u; }
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return null;
  const c = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return c <= 0 ? 0 : c >= 1 ? 1 : c;
}
/** the cosine of two pieces of TEXT, rounded the way the collector records it (6 decimals) */
const cosineOfText = (x, y) => round6(cosine(countWords(x), countWords(y)));
const round6 = (v) => (v === null ? null : Math.round(v * 1e6) / 1e6);

// ── headings ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** a line that begins an item: leading bullet/quote/underscore noise, "Item", the number, an optional letter, then the rest */
const ITEM_LINE = /^[\s>*#|~_]*item\s*(\d{1,2})\s*([a-c])?[\s.:)\]\-–—]*(.*)$/i;
/** a line that begins a part: "PART I", "Part II.", "PART IV — …" */
const PART_LINE = /^[\s>*#|~_]*part\s+(iv|iii|ii|i|[1-4])\b/i;
const PART_NO = Object.freeze({ i: 1, ii: 2, iii: 3, iv: 4, 1: 1, 2: 2, 3: 3, 4: 4 });
/** the signatures page ends the last item; exhibits indexes and certifications after it are not part of any section */
const SIGNATURE_LINE = /^\s*signatures?\s*$/i;
/**
 * At most this many characters of ONE heading's evidence count when two chains are compared (header, rule 3). Capping matters
 * because one enormous section must not outvote several ordinary ones; 300 is well above a contents line (tens of characters) and
 * well below any real section, so a chain of k real sections scores about k*300 and a chain of k contents entries about k*40.
 */
const EVIDENCE_CAP = 300;

/** the standard title at the head of `rest`, removed — "Business and our markets" over Item 1 keeps "and our markets" */
function stripTitle(rest, title) {
  if (!title) return rest;
  const words = tokenize(title);
  if (!words.length) return rest;
  let i = 0, consumed = 0;
  const lower = rest.toLowerCase();
  for (const w of words) {
    const re = new RegExp(`^[^a-z]*${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    const m = re.exec(lower.slice(i));
    if (!m) break;
    i += m[0].length;
    consumed++;
  }
  // only a title that matched (nearly) whole is removed: a part of one is a different heading and its words stay
  if (consumed < words.length && !(words.length > 6 && consumed >= words.length - 2)) return rest;
  return rest.slice(i).replace(/^[^a-zA-Z0-9]+/, "");
}

/**
 * Every line-start item heading in the text, as CANDIDATES. For a 10-Q an item that both parts define is offered twice, once per
 * part, at the same position: the chain can take at most one of them (it must move strictly forward through the text).
 *   { pos, bodyStart, evidence, idx, id, item, part, title, headingLine, agreesWithPart }
 * `evidence` is set by evidenceOf() once every candidate is known: the capped distance from the end of this heading to the next
 * heading match of ANY kind, used or not (header, rule 3).
 */
function candidates(text, form) {
  const out = [];
  let offset = 0, part = 0;
  for (const line of text.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    const p = PART_LINE.exec(line);
    if (p) { part = PART_NO[p[1].toLowerCase()] || part; continue; }
    const m = ITEM_LINE.exec(line);
    if (!m) continue;
    const item = (m[1] + (m[2] || "")).toUpperCase();
    const rest = m[3] || "";
    const parts = form === "10-Q" ? [1, 2] : [0];
    for (const pt of parts) {
      const title = titleOf(form, pt, item);
      if (!title) continue;
      const idx = form === "10-Q" ? Q_ORDER.indexOf(`${pt}:${item}`) : K_ORDER.indexOf(item);
      if (idx < 0) continue;
      out.push({
        pos: start,
        bodyStart: start + (line.length - rest.length),
        trimmedRest: stripTitle(rest, title),
        idx, id: sectionId(form, pt, item), item,
        part: form === "10-Q" ? pt : K_PART(item),
        title, headingLine: line.trim(),
        agreesWithPart: form === "10-Q" && pt === part ? 1 : 0,
        evidence: 0,
      });
    }
  }
  return out;
}
/**
 * Fill in each candidate's evidence: the capped number of characters between the end of its heading and the next heading match in
 * the text, whoever that match belongs to. `end` closes the last one. Pure; it mutates nothing the caller did not just build.
 */
function evidenceOf(cands, end) {
  for (let i = 0; i < cands.length; i++) {
    let next = end;
    for (let j = i + 1; j < cands.length; j++) if (cands[j].pos > cands[i].pos) { next = cands[j].pos; break; }
    cands[i].evidence = Math.min(Math.max(next - cands[i].bodyStart, 0), EVIDENCE_CAP);
  }
  return cands;
}

/** compare two chain summaries: more items wins, then more evidence, then more agreement with the PART headings */
function better(a, b) {
  if (a.count !== b.count) return a.count > b.count;
  if (a.sum !== b.sum) return a.sum > b.sum;
  return a.agree > b.agree;
}
/**
 * The chain of candidates the sections are read from (header, rules 1-4). O(n^2) over the candidates of one filing, which is tens.
 * `end` is where the last item stops (the signatures line, or the end of the text) and closes the last candidate's evidence.
 */
function chooseChain(cands, end) {
  const n = cands.length;
  if (!n) return [];
  evidenceOf(cands, end);
  const dp = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let best = { count: 1, sum: cands[i].evidence, agree: cands[i].agreesWithPart, next: -1 };
    for (let j = i + 1; j < n; j++) {
      if (cands[j].pos <= cands[i].pos || cands[j].idx <= cands[i].idx) continue;
      const cand = { count: 1 + dp[j].count, sum: cands[i].evidence + dp[j].sum, agree: cands[i].agreesWithPart + dp[j].agree, next: j };
      if (better(cand, best)) best = cand;
    }
    dp[i] = best;
  }
  let start = 0;
  for (let i = 1; i < n; i++) if (better(dp[i], dp[start]) || (!better(dp[start], dp[i]) && cands[i].pos > cands[start].pos)) start = i;
  const chain = [];
  for (let i = start; i !== -1; i = dp[i].next) chain.push(i);
  return chain.map((i) => cands[i]);
}

/**
 * Split one filing's saved text into its standard sections.
 *   splitSections(raw, { form: "10-K" }) -> { form, textLength, sections, found, warnings }
 * A section: { id, item, part, title, headingLine, start, end, text, words }. `text` excludes the heading's standard title.
 * THROWS only on a form this file does not know; a filing it cannot split comes back with sections: [] and a warning.
 */
function splitSections(raw, { form } = {}) {
  const f = baseForm(form);
  if (!f) throw new Error(`filing-sections: form ${JSON.stringify(form)} is not a 10-K or a 10-Q`);
  const text = normalizeText(raw);
  const warnings = [];

  // where the last item stops: the last line that is only the word SIGNATURES, if there is one
  let end = text.length;
  {
    let offset = 0;
    for (const line of text.split("\n")) { if (SIGNATURE_LINE.test(line)) end = offset; offset += line.length + 1; }
  }
  const cands = candidates(text, f);
  if (end <= (cands.length ? cands[0].pos : 0)) end = text.length;   // a "SIGNATURES" line before the first heading is not the end
  const chain = chooseChain(cands, end);

  const sections = chain.map((c, k) => {
    const stop = k + 1 < chain.length ? chain[k + 1].pos : Math.max(end, c.bodyStart);
    const body = (c.trimmedRest ? c.trimmedRest + "\n" : "") + text.slice(c.bodyStart, Math.max(stop, c.bodyStart)).replace(/^[^\n]*\n?/, "");
    const clean = body.trim();
    return { id: c.id, item: c.item, part: c.part, title: c.title, headingLine: c.headingLine, start: c.pos, end: Math.max(stop, c.bodyStart), text: clean, words: tokenize(clean).length };
  });

  if (!sections.length) warnings.push(`no standard ${f} item heading was found in ${text.length} characters of text`);
  else if (sections.length < 3) warnings.push(`only ${sections.length} standard ${f} item heading(s) were found — the text may be an exhibit or a cover page rather than the filing`);
  const empty = sections.filter((s) => s.words === 0).map((s) => s.id);
  if (empty.length) warnings.push(`${empty.length} section(s) have no words: ${empty.join(", ")}`);

  return { form: f, textLength: text.length, sections, found: sections.map((s) => s.id), warnings };
}
/** { id: text } for the sections of one filing */
const sectionTexts = (result) => Object.fromEntries(result.sections.map((s) => [s.id, s.text]));

// ── selftest ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
function selftest() {
  let pass = 0, fail = 0;
  const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail === undefined ? "" : " — " + detail)); } };
  const near = (a, b) => a !== null && Math.abs(a - b) < 1e-9;

  // words
  ok("tokenize: lower-case letter runs; apostrophes and hyphens stay inside a word; digits are not words",
    JSON.stringify(tokenize("The Company's 2024 well-known 10-K risk, $3.5M.")) === JSON.stringify(["the", "company's", "well-known", "k", "risk", "m"]),
    JSON.stringify(tokenize("The Company's 2024 well-known 10-K risk, $3.5M.")));
  ok("countWords: repeats are counted", (() => { const c = countWords("beta Beta gamma"); return c.get("beta") === 2 && c.get("gamma") === 1 && c.size === 2; })());

  // cosine — the arithmetic by hand:
  //   a = "alpha beta beta gamma" -> {alpha:1, beta:2, gamma:1}, |a| = sqrt(1+4+1) = sqrt 6
  //   b = "beta gamma gamma delta" -> {beta:1, gamma:2, delta:1}, |b| = sqrt 6
  //   dot = beta 2*1 + gamma 1*2 = 4;  cos = 4 / 6 = 0.666666…
  ok("cosine: the worked example 'alpha beta beta gamma' vs 'beta gamma gamma delta' = 4/6 = 0.666667", cosineOfText("alpha beta beta gamma", "beta gamma gamma delta") === 0.666667 && near(cosine(countWords("alpha beta beta gamma"), countWords("beta gamma gamma delta")), 2 / 3), String(cosineOfText("alpha beta beta gamma", "beta gamma gamma delta")));
  ok("the item order is the FORM's, not the order JavaScript lists object keys in (Item 1A is second, Item 7A is eleventh, Item 16 is last)",
    K_ORDER.indexOf("1A") === 1 && K_ORDER.indexOf("7A") === 10 && K_ORDER.indexOf("16") === K_ORDER.length - 1 && K_ORDER.indexOf("1A") < K_ORDER.indexOf("2") && K_ORDER.indexOf("9C") < K_ORDER.indexOf("10") &&
    Q_ORDER.indexOf("2:1") === 4 && Q_ORDER.indexOf("2:1A") === 5 && Q_ORDER.every((k) => Object.prototype.hasOwnProperty.call(Q_TITLES, k)) && K_ORDER.every((k) => Object.prototype.hasOwnProperty.call(K_TITLES, k)) &&
    K_ORDER.length === Object.keys(K_TITLES).length && Q_ORDER.length === Object.keys(Q_TITLES).length,
    JSON.stringify(K_ORDER));
  ok("cosine: the same text = 1; word order does not matter", cosineOfText("one two two three", "one two two three") === 1 && cosineOfText("one two two three", "three two one two") === 1);
  ok("cosine: no shared word = 0", cosineOfText("alpha beta", "gamma delta") === 0);
  ok("cosine: an empty side = null, never 0", cosineOfText("", "alpha") === null && cosineOfText("alpha", "") === null && cosineOfText("2024 $5", "alpha") === null);
  ok("cosine: proportions, not lengths — the same text twice over scores 1", cosineOfText("alpha beta", "alpha beta alpha beta") === 1);

  // text
  ok("normalizeText: markup is stripped, entities decoded, blank-line runs cut",
    normalizeText("<html><body><p>Item&nbsp;1. Business</p><div>We&amp;Co make widgets.</div><br><br><br></body></html>") === "Item 1. Business\n\nWe&Co make widgets.\n",
    JSON.stringify(normalizeText("<html><body><p>Item&nbsp;1. Business</p><div>We&amp;Co make widgets.</div><br><br><br></body></html>")));
  ok("normalizeText: plain text is left as it is apart from line endings and spacing", normalizeText("Item 1. Business\r\n\r\n\r\n\r\nWe make widgets.  Really.\r\n") === "Item 1. Business\n\nWe make widgets. Really.\n");
  ok("decodeEntities: an unknown entity is left alone", decodeEntities("&amp; &zzz; &#65; &#x42;") === "& &zzz; A B");

  // the table of contents must not become the sections
  const TOC_10K = [
    "SAMPLE WIDGETS INC", "FORM 10-K", "", "TABLE OF CONTENTS", "",
    "Item 1. Business", "Item 1A. Risk Factors", "Item 3. Legal Proceedings", "Item 7. Management's Discussion and Analysis of Financial Condition and Results of Operations", "",
    "PART I", "", "Item 1. Business", "We make widgets for the widget trade and we have done so for many years in many places.", "",
    "Item 1A. Risk Factors", "Widgets may go out of fashion and our suppliers may raise their prices without any warning at all.", "",
    "Item 3. Legal Proceedings", "There are no material pending legal proceedings against the company or any of its subsidiaries.", "",
    "Item 7. Management's Discussion and Analysis of Financial Condition and Results of Operations", "Revenue rose because we sold more widgets than we sold in the year before this one.", "",
    "SIGNATURES", "", "Signed by the registrant.", "",
  ].join("\n");
  const k = splitSections(TOC_10K, { form: "10-K" });
  ok("10-K: the four items are found once each, in order (the table of contents is not mistaken for them)", JSON.stringify(k.found) === JSON.stringify(["item1", "item1a", "item3", "item7"]), JSON.stringify(k.found));
  ok("10-K: each section holds its own body, not the contents listing", /widget trade/.test(k.sections[0].text) && !/Risk Factors/.test(k.sections[0].text) && /out of fashion/.test(k.sections[1].text));
  ok("10-K: the standard title is removed from the body, so two short sections are not alike through their heading alone", !/^Business/.test(k.sections[0].text) && !/^Management's Discussion/.test(k.sections[3].text), JSON.stringify(k.sections[3].text.slice(0, 40)));
  ok("10-K: the last section stops at SIGNATURES", !/Signed by the registrant/.test(k.sections[3].text), k.sections[3].text);
  ok("10-K: the part of each item is recorded (Item 1 and 1A in Part I, Item 7 in Part II)", k.sections[0].part === 1 && k.sections[1].part === 1 && k.sections[3].part === 2);

  // the same shape at REAL size: contents entries that carry a page number, and sections of thousands of characters
  const BIG_ITEMS = ["1", "1A", "1B", "2", "3", "7", "7A", "8"];
  const bulk = (w) => (`${w} the widget trade continued without interruption through the whole of the period under review. `).repeat(50);
  const BIG_10K = [
    "SAMPLE WIDGETS INC", "FORM 10-K", "", "TABLE OF CONTENTS", "",
    ...BIG_ITEMS.map((it, i) => `Item ${it}. ${K_TITLES[it]} ${(i + 1) * 7}`), "",
    "PART I", "",
    ...BIG_ITEMS.flatMap((it) => [`Item ${it}. ${K_TITLES[it]}`, bulk(`body-of-item-${it.toLowerCase()}`), ""]),
    "SIGNATURES", "", "Signed by the registrant.",
  ].join("\n");
  const big = splitSections(BIG_10K, { form: "10-K" });
  ok("10-K at real size: eight sections of about 5,000 characters each, and every body is its own (the contents, page numbers and all, loses)",
    JSON.stringify(big.found) === JSON.stringify(BIG_ITEMS.map((it) => "item" + it.toLowerCase())) &&
    big.sections.every((s, i) => s.text.startsWith(`body-of-item-${BIG_ITEMS[i].toLowerCase()}`) && s.words > 500 && !/TABLE OF CONTENTS/.test(s.text)),
    JSON.stringify(big.sections.map((s) => [s.id, s.words])));

  // a cross-reference at the start of a line must not open a section
  const XREF = TOC_10K.replace("Revenue rose because we sold more widgets than we sold in the year before this one.",
    "Item 3. Legal Proceedings are described above and nothing further is reported here.\nRevenue rose because we sold more widgets than we sold in the year before this one.");
  const x = splitSections(XREF, { form: "10-K" });
  ok("10-K: a line inside Item 7 that starts 'Item 3.' is a cross-reference, not a section (the chain never goes backwards)",
    JSON.stringify(x.found) === JSON.stringify(["item1", "item1a", "item3", "item7"]) && /described above/.test(x.sections[3].text) && /no material pending/.test(x.sections[2].text), JSON.stringify(x.found));

  // 10-Q: the same item number means two different things
  const Q = [
    "SAMPLE WIDGETS INC", "FORM 10-Q", "", "PART I — FINANCIAL INFORMATION", "",
    "Item 1. Financial Statements", "The unaudited statements of the quarter are set out on the pages that follow this one.", "",
    "Item 2. Management's Discussion and Analysis of Financial Condition and Results of Operations", "Revenue for the quarter rose on stronger widget demand across every region we serve.", "",
    "Item 4. Controls and Procedures", "Our disclosure controls were effective as of the end of the period covered by this report.", "",
    "PART II — OTHER INFORMATION", "",
    "Item 1. Legal Proceedings", "There are no material pending legal proceedings against the company or any subsidiary.", "",
    "Item 1A. Risk Factors", "alpha beta beta gamma", "",
    "Item 6. Exhibits", "The exhibits required by this item are listed in the index that follows the signatures.", "",
  ].join("\n");
  const q = splitSections(Q, { form: "10-Q" });
  ok("10-Q: ids carry the part, so Part I Item 1 and Part II Item 1 are different sections",
    JSON.stringify(q.found) === JSON.stringify(["p1item1", "p1item2", "p1item4", "p2item1", "p2item1a", "p2item6"]), JSON.stringify(q.found));
  ok("10-Q: each one holds its own text", /unaudited statements/.test(sectionTexts(q).p1item1) && /no material pending/.test(sectionTexts(q).p2item1) && sectionTexts(q).p2item1a === "alpha beta beta gamma");
  const qNoParts = splitSections(Q.replace(/^PART (I|II).*$/gm, ""), { form: "10-Q" });
  ok("10-Q: a filing whose body never writes 'PART I' still splits the same way (the item count decides, the part headings only break ties)",
    JSON.stringify(qNoParts.found) === JSON.stringify(q.found), JSON.stringify(qNoParts.found));

  // what it refuses to guess
  ok("a form that is not a 10-K or a 10-Q throws", (() => { try { splitSections("x", { form: "8-K" }); return false; } catch (e) { return /not a 10-K or a 10-Q/.test(e.message); } })());
  ok("10-K/A and 10-Q/A are read as 10-K and 10-Q", splitSections(TOC_10K, { form: "10-K/A" }).form === "10-K" && splitSections(Q, { form: "10-q/a" }).form === "10-Q");
  const none = splitSections("This document holds no item headings of any kind whatsoever.", { form: "10-K" });
  ok("a text with no item heading gives no sections and says so, rather than guessing one", none.sections.length === 0 && /no standard 10-K item heading/.test(none.warnings[0] || ""), JSON.stringify(none.warnings));
  const bare = splitSections("Item 1. Business\n\nItem 1A. Risk Factors\nSomething is risky around here.\n\nItem 3. Legal Proceedings\nNothing is pending.\n", { form: "10-K" });
  ok("a section with no words is kept but reported in warnings, so the collector can skip it instead of scoring it",
    bare.found.length === 3 && bare.sections[0].words === 0 && /no words: item1/.test(bare.warnings.join(" | ")), JSON.stringify(bare.warnings));
  ok("stripTitle: the whole standard title goes, a partial one stays (so a different heading is not silently trimmed)",
    stripTitle("Business and our markets", "Business") === "and our markets" && stripTitle("Risk", "Risk Factors") === "Risk" && stripTitle("", "Business") === "" &&
    stripTitle("RISK FACTORS — updated", "Risk Factors") === "updated", JSON.stringify([stripTitle("Business and our markets", "Business"), stripTitle("Risk", "Risk Factors"), stripTitle("RISK FACTORS — updated", "Risk Factors")]));
  ok("evidence is measured to the NEXT heading match of any kind, used or not, and is capped",
    (() => { const c = evidenceOf([{ pos: 0, bodyStart: 10, evidence: 0 }, { pos: 100, bodyStart: 110, evidence: 0 }, { pos: 5000, bodyStart: 5010, evidence: 0 }], 9000); return c[0].evidence === 90 && c[1].evidence === EVIDENCE_CAP && c[2].evidence === EVIDENCE_CAP; })());

  console.log(`filing-sections selftest: ${pass} passed, ${fail} failed — ${fail === 0 ? "PASSED" : "FAILED"}`);
  return fail === 0;
}

module.exports = {
  K_TITLES, K_ORDER, Q_TITLES, Q_ORDER, EVIDENCE_CAP,
  baseForm, sectionId, titleOf,
  decodeEntities, looksLikeMarkup, htmlToText, normalizeText,
  tokenize, countWords, totalWords, cosine, cosineOfText, round6,
  stripTitle, candidates, evidenceOf, chooseChain, splitSections, sectionTexts,
  selftest,
};

if (require.main === module) {
  if (process.argv.includes("--selftest")) process.exitCode = selftest() ? 0 : 1;
  else { console.log("filing-sections.js: the parse layer of the wording-change collector (splitSections, cosine). --selftest runs its checks."); process.exitCode = 2; }
}
