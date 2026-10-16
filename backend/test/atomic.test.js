/**
 * ATOMIC WRITES — the guard against losing an append-only ledger to a mid-write crash.
 *
 * Uses a real temp directory rather than mocks: the whole point is filesystem behaviour, and a
 * mocked rename proves nothing about whether the bytes landed.
 */
const { suite, test, eq, ok, throws } = require("./run");
const fs = require("fs"), os = require("os"), path = require("path");
const { writeJsonAtomic, readJsonSafe } = require("../lib/atomic");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "traids-atomic-"));
const p = (n) => path.join(dir, n);

suite("atomic · writes are all-or-nothing", () => {
  test("writes and reads back a ledger", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, rMult: i / 100 }));
    writeJsonAtomic(p("ledger.json"), rows);
    eq(readJsonSafe(p("ledger.json")).length, 500);
  });

  test("leaves NO temp files behind on success", () => {
    writeJsonAtomic(p("clean.json"), { a: 1 });
    eq(fs.readdirSync(dir).filter(f => f.includes(".tmp-")).length, 0);
  });

  test("the existing file is untouched when the payload is invalid", () => {
    writeJsonAtomic(p("keep.json"), { good: true });
    throws(() => writeJsonAtomic(p("keep.json"), "{not json"), "invalid JSON must be refused");
    eq(readJsonSafe(p("keep.json")), { good: true }, "the original must survive a refused write");
  });

  test("refuses to replace a ledger with an empty payload", () => {
    writeJsonAtomic(p("ledger2.json"), [{ id: 1 }]);
    throws(() => writeJsonAtomic(p("ledger2.json"), "", { minBytes: 2 }));
    eq(readJsonSafe(p("ledger2.json")).length, 1, "a zero-byte write must not land");
  });

  test("refuses a BOM — the 2026-08-05 registry corruption signature", () => {
    throws(() => writeJsonAtomic(p("bom.json"), "﻿{\"a\":1}"));
  });

  test("no temp file survives a refused write", () => {
    try { writeJsonAtomic(p("x.json"), "{bad"); } catch { }
    eq(fs.readdirSync(dir).filter(f => f.includes(".tmp-")).length, 0);
  });

  test("round-trips non-ASCII without mojibake", () => {
    const obj = { note: "R12 lost a t of −4.26 → −0.96 — em dashes and minus signs" };
    writeJsonAtomic(p("utf8.json"), obj);
    eq(readJsonSafe(p("utf8.json")), obj);
    const raw = fs.readFileSync(p("utf8.json"), "utf8");
    eq((raw.match(/â|Â/g) || []).length, 0, "no mojibake sequences");
    eq(raw.charCodeAt(0) === 0xfeff, false, "no BOM");
  });

  test("readJsonSafe tolerates a BOM already on disk", () => {
    fs.writeFileSync(p("hasbom.json"), "﻿{\"ok\":1}", "utf8");
    eq(readJsonSafe(p("hasbom.json")), { ok: 1 });
  });

  test("readJsonSafe returns the fallback rather than throwing", () => {
    eq(readJsonSafe(p("missing.json"), "fallback"), "fallback");
  });

  test("a truncated file is what we are defending against — plain write shows the hazard", () => {
    // demonstrate the failure mode the helper exists to prevent
    fs.writeFileSync(p("plain.json"), JSON.stringify([{ id: 1 }, { id: 2 }]));
    fs.writeFileSync(p("plain.json"), "");          // simulates a crash mid-truncate
    eq(readJsonSafe(p("plain.json"), "LOST"), "LOST", "a plain write can leave nothing behind");
  });
});
