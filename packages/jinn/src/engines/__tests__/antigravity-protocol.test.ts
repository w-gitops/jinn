import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  extractDoneResponses,
  transcriptLineToDeltas,
  ensureWorkspaceTrusted,
} from "../antigravity-protocol.js";

const USER_LINE = `{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"<USER_REQUEST>\\nhi\\n</USER_REQUEST>"}`;
const HISTORY_LINE = `{"step_index":1,"source":"SYSTEM","type":"CONVERSATION_HISTORY","status":"DONE"}`;
const MODEL_DONE = `{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"alpha beta gamma"}`;
const MODEL_INPROGRESS = `{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"IN_PROGRESS","content":"thinking..."}`;
const MODEL_DONE_2 = `{"step_index":4,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"second answer"}`;

describe("extractDoneResponses", () => {
  it("returns only MODEL/PLANNER_RESPONSE entries with status DONE, in order", () => {
    const content = [USER_LINE, HISTORY_LINE, MODEL_DONE, MODEL_DONE_2].join("\n");
    expect(extractDoneResponses(content)).toEqual(["alpha beta gamma", "second answer"]);
  });

  it("ignores non-DONE responses and non-model rows", () => {
    const content = [USER_LINE, MODEL_INPROGRESS, MODEL_DONE].join("\n");
    expect(extractDoneResponses(content)).toEqual(["alpha beta gamma"]);
  });

  it("skips malformed / blank lines", () => {
    const content = ["", "not json", MODEL_DONE, "  "].join("\n");
    expect(extractDoneResponses(content)).toEqual(["alpha beta gamma"]);
  });

  it("returns empty for an empty transcript", () => {
    expect(extractDoneResponses("")).toEqual([]);
  });
});

describe("transcriptLineToDeltas", () => {
  it("emits a text delta for a DONE model response", () => {
    expect(transcriptLineToDeltas(MODEL_DONE)).toEqual([{ type: "text", content: "alpha beta gamma" }]);
  });

  it("emits nothing for user input, history, or junk", () => {
    expect(transcriptLineToDeltas(USER_LINE)).toEqual([]);
    expect(transcriptLineToDeltas(HISTORY_LINE)).toEqual([]);
    expect(transcriptLineToDeltas("garbage")).toEqual([]);
    expect(transcriptLineToDeltas("")).toEqual([]);
  });
});

describe("ensureWorkspaceTrusted", () => {
  let dir: string;
  let settingsPath: string;
  let ws: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-trust-"));
    settingsPath = path.join(dir, "settings.json");
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ws-"));
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("creates settings.json with the realpath'd workspace when none exists", () => {
    ensureWorkspaceTrusted(ws, settingsPath);
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(data.trustedWorkspaces).toContain(fs.realpathSync(ws));
  });

  it("is idempotent — no duplicate entries on repeat calls", () => {
    ensureWorkspaceTrusted(ws, settingsPath);
    ensureWorkspaceTrusted(ws, settingsPath);
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const real = fs.realpathSync(ws);
    expect(data.trustedWorkspaces.filter((w: string) => w === real)).toHaveLength(1);
  });

  it("preserves pre-existing settings keys and entries", () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ enableTelemetry: false, trustedWorkspaces: ["/already/here"] }));
    ensureWorkspaceTrusted(ws, settingsPath);
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(data.enableTelemetry).toBe(false);
    expect(data.trustedWorkspaces).toContain("/already/here");
    expect(data.trustedWorkspaces).toContain(fs.realpathSync(ws));
  });

  it("does not throw on a malformed existing settings file (rewrites it)", () => {
    fs.writeFileSync(settingsPath, "{ not valid json");
    expect(() => ensureWorkspaceTrusted(ws, settingsPath)).not.toThrow();
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(data.trustedWorkspaces).toContain(fs.realpathSync(ws));
  });
});
