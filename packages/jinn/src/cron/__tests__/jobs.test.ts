import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CronJob } from "../../shared/types.js";

// Stub logger so tests don't touch the real log files
vi.mock("../../shared/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// CRON_JOBS is resolved at module load from process.env.JINN_HOME, so we point
// it at a temp dir and re-import the module graph per test (same pattern as
// the context.ts tests).
let tmpHome: string;
const prevHome = process.env.JINN_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-cron-jobs-"));
  process.env.JINN_HOME = tmpHome;
  vi.resetModules();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = prevHome;
  vi.resetModules();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function importJobs() {
  const jobs = await import("../jobs.js");
  const { logger } = await import("../../shared/logger.js");
  return { ...jobs, logger };
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job",
    name: "Test Job",
    enabled: true,
    schedule: "0 * * * *",
    prompt: "do something",
    ...overrides,
  };
}

describe("loadJobs", () => {
  it("returns [] silently when jobs.json is missing", async () => {
    const { loadJobs, logger } = await importJobs();
    expect(loadJobs()).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs an error and backs up the corrupt file on parse failure", async () => {
    const cronDir = path.join(tmpHome, "cron");
    fs.mkdirSync(cronDir, { recursive: true });
    const jobsPath = path.join(cronDir, "jobs.json");
    fs.writeFileSync(jobsPath, "{ not valid json", "utf-8");

    const { loadJobs, logger } = await importJobs();
    expect(loadJobs()).toEqual([]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(logger.error).mock.calls[0][0])).toContain("Failed to parse");

    // Corrupt copy is preserved next to the original
    const backups = fs.readdirSync(cronDir).filter((f) => f.startsWith("jobs.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(cronDir, backups[0]), "utf-8")).toBe("{ not valid json");
    // Original file is left in place
    expect(fs.existsSync(jobsPath)).toBe(true);
  });
});

describe("saveJobs", () => {
  it("round-trips jobs through loadJobs and leaves no tmp file behind", async () => {
    const { loadJobs, saveJobs } = await importJobs();
    const jobs = [makeJob(), makeJob({ id: "other-job", name: "Other Job", enabled: false })];

    saveJobs(jobs);
    expect(loadJobs()).toEqual(jobs);

    const cronDir = path.join(tmpHome, "cron");
    const leftovers = fs.readdirSync(cronDir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});
