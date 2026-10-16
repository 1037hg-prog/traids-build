// SEAT-SDK TRIAL — the entry point of the selftest's FAKE package. The selftest copies this file (as index.mjs) and fake-sdk-core.cjs into
// <temp tree>/automation/seat-sdk/node_modules/@anthropic-ai/claude-agent-sdk/, beside a package.json that says "traidsFake": true.
// It exports query() like the real package and nothing else; it makes no network call and starts no process.
import { createRequire } from "node:module";
const core = createRequire(import.meta.url)("./fake-sdk-core.cjs");
export const query = core.fromEnv();
