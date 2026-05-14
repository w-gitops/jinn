#!/usr/bin/env node
// Jinn hook relay. Invoked by Claude Code hooks as: node hook-relay.mjs <jinnSessionId>
// Reads hook JSON on stdin, POSTs to the gateway's /api/internal/hook. Always exits 0.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const jinnSessionId = process.argv[2];
const JINN_HOME = process.env.JINN_HOME || path.join(os.homedir(), `.${process.env.JINN_INSTANCE || "jinn"}`);

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }

  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(JINN_HOME, "gateway.json"), "utf-8")); } catch { return; }

  const body = JSON.stringify({ jinnSessionId, hook: payload });
  await fetch(`http://127.0.0.1:${info.port}/api/internal/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-jinn-hook-secret": info.secret },
    body,
  }).catch(() => {});
}

main().catch(() => {}).finally(() => process.exit(0));
