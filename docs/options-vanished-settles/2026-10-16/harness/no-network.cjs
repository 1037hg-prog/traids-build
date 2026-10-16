"use strict";
/**
 * NO NETWORK (options-vanished-settles 2026-10-16). Preloaded with `node -r` into every process this package's selftest starts.
 *
 * The house rule is that a test makes NO broker call and no network call of any kind. This file does not trust the code under test to
 * honour it: it takes the door off. fetch, http.request / https.request / get, net.Socket.prototype.connect and dns.lookup each throw
 * at once, and every attempt is appended to the file named by OVS_NETLOG, so a check can assert that the count is ZERO rather than
 * assume it. Nothing here is reachable from the live code: it exists only inside the selftest's own child processes.
 */
const fs = require("fs");
const LOG = process.env.OVS_NETLOG || "";
function refuse(kind, detail) {
  const line = JSON.stringify({ kind, detail: String(detail).slice(0, 200), at: new Date().toISOString() });
  if (LOG) { try { fs.appendFileSync(LOG, line + "\n"); } catch { /* the throw below is the real signal */ } }
  throw new Error(`NETWORK REFUSED in a test: ${kind} ${String(detail).slice(0, 120)}`);
}
globalThis.fetch = (...a) => refuse("fetch", a[0]);
for (const mod of ["http", "https"]) {
  const m = require(mod);
  m.request = (...a) => refuse(`${mod}.request`, a[0]);
  m.get = (...a) => refuse(`${mod}.get`, a[0]);
}
try { const net = require("net"); const C = net.Socket.prototype.connect; net.Socket.prototype.connect = function (...a) { refuse("net.connect", JSON.stringify(a[0])); return C.apply(this, a); }; } catch { /* none */ }
try { const dns = require("dns"); dns.lookup = (...a) => refuse("dns.lookup", a[0]); } catch { /* none */ }
