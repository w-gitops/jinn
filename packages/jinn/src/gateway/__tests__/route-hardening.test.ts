import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ServerResponse } from "node:http";

/**
 * Route-level tests for two hardened GET handlers in ../api.ts:
 *   - GET /api/cron/:id/runs   → skips corrupt JSONL lines, returns the good rows
 *   - GET /api/org/departments/:name/board → 500s on a corrupt board.json
 *
 * Both handlers resolve their on-disk paths from CRON_RUNS / ORG_DIR in
 * ../../shared/paths.js, so we mock that module to point at a temp dir. The
 * handlers return early (before touching session/connector state), so a minimal
 * ApiContext stub is sufficient. We drive handleApiRequest directly with fake
 * req/res objects — no HTTP server boot required.
 */

// Initialized at module load (before the mocked paths.js getters can be hit by
// import-time consumers like usageAwareness.ts). Re-pointed per test in beforeEach.
const bootHome = fs.mkdtempSync(path.join(os.tmpdir(), "route-harden-boot-"));
let tmpHome = bootHome;
let cronRunsDir = path.join(tmpHome, "cron", "runs");
let orgDir = path.join(tmpHome, "org");

vi.mock("../../shared/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/paths.js")>();
  return {
    ...actual,
    // Only override the two dirs the target routes read. JINN_HOME is left as
    // the real value so import-time consumers don't break.
    get CRON_RUNS() {
      return cronRunsDir;
    },
    get ORG_DIR() {
      return orgDir;
    },
  };
});

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleApiRequest } from "../api.js";
import type { ApiContext } from "../api.js";

interface CapturedRes {
  res: ServerResponse;
  get status(): number;
  get body(): unknown;
}

function makeRes(): CapturedRes {
  let status = 200;
  let chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

function makeReq(method: string, urlPath: string) {
  return {
    method,
    url: urlPath,
    headers: { host: "localhost" },
  } as unknown as Parameters<typeof handleApiRequest>[0];
}

// Minimal context — the target routes return before reading these fields.
const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
} as unknown as ApiContext;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "route-harden-"));
  cronRunsDir = path.join(tmpHome, "cron", "runs");
  orgDir = path.join(tmpHome, "org");
  fs.mkdirSync(cronRunsDir, { recursive: true });
  fs.mkdirSync(orgDir, { recursive: true });
});

afterEach(() => {
  if (tmpHome && fs.existsSync(tmpHome)) fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

afterAll(() => {
  if (fs.existsSync(bootHome)) fs.rmSync(bootHome, { recursive: true, force: true });
});

describe("GET /api/cron/:id/runs — corrupt-line tolerance", () => {
  it("skips a dangling/corrupt JSONL line and returns the good rows, newest first", async () => {
    const good1 = JSON.stringify({ ts: "2026-01-01T00:00:00Z", ok: true });
    const good2 = JSON.stringify({ ts: "2026-01-02T00:00:00Z", ok: false });
    // A crash mid-write can leave a half-written final line.
    const corrupt = '{"ts":"2026-01-03T00:00:00Z","ok"';
    fs.writeFileSync(path.join(cronRunsDir, "my-job.jsonl"), [good1, corrupt, good2].join("\n"));

    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/cron/my-job/runs"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(Array.isArray(cap.body)).toBe(true);
    expect(cap.body).toEqual([
      { ts: "2026-01-02T00:00:00Z", ok: false },
      { ts: "2026-01-01T00:00:00Z", ok: true },
    ]);
  });

  it("honors ?limit=N, returning only the newest N runs", async () => {
    const lines = [1, 2, 3, 4].map((n) => JSON.stringify({ n }));
    fs.writeFileSync(path.join(cronRunsDir, "my-job.jsonl"), lines.join("\n") + "\n");

    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/cron/my-job/runs?limit=2"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual([{ n: 4 }, { n: 3 }]);
  });

  it("returns [] when the run file does not exist", async () => {
    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/cron/no-such-job/runs"), cap.res, ctx);
    expect(cap.status).toBe(200);
    expect(cap.body).toEqual([]);
  });
});

describe("GET /api/org/departments/:name/board — corrupt board.json", () => {
  it("returns 500 when board.json is not valid JSON", async () => {
    const deptDir = path.join(orgDir, "platform");
    fs.mkdirSync(deptDir, { recursive: true });
    fs.writeFileSync(path.join(deptDir, "board.json"), "{ this is not json ]");

    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/org/departments/platform/board"), cap.res, ctx);

    expect(cap.status).toBe(500);
    expect(cap.body).toMatchObject({ error: expect.stringContaining("corrupt") });
  });

  it("returns 200 with the parsed board when board.json is valid", async () => {
    const deptDir = path.join(orgDir, "platform");
    fs.mkdirSync(deptDir, { recursive: true });
    const board = { todo: ["a"], in_progress: [], done: ["b"] };
    fs.writeFileSync(path.join(deptDir, "board.json"), JSON.stringify(board));

    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/org/departments/platform/board"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual(board);
  });
});
