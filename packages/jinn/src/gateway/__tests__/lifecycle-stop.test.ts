import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Point JINN_HOME at a temp dir BEFORE importing the module under test so
// PID_FILE resolves inside it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-lifecycle-stop-"));
process.env.JINN_HOME = tmpHome;

const { stop, stopAndWait } = await import("../lifecycle.js");
const { PID_FILE } = await import("../../shared/paths.js");

/** Pick a free ephemeral port (nothing will be listening on it afterwards). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Spawn a child that exits `delayMs` after receiving SIGTERM (simulating graceful shutdown). */
function spawnSlowShutdownChild(delayMs: number): ChildProcess {
  const script = `process.on("SIGTERM", () => setTimeout(() => process.exit(0), ${delayMs})); setInterval(() => {}, 1000);`;
  return spawn(process.execPath, ["-e", script], { stdio: "ignore" });
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

describe("stop / stopAndWait PID-file race", () => {
  const children: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      await waitForExit(child);
    }
    fs.rmSync(PID_FILE, { force: true });
  });

  it("stop() leaves the PID file in place while the process is still shutting down", async () => {
    const child = spawnSlowShutdownChild(500);
    children.push(child);
    await waitForSpawn(child);
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid));

    const stopped = stop(await freePort());
    expect(stopped).toBe(true);
    // The fix: no early unlink — a concurrent start/status must keep seeing
    // the (still running) gateway until it actually exits.
    expect(fs.existsSync(PID_FILE)).toBe(true);
    expect(child.exitCode).toBe(null); // still shutting down

    await waitForExit(child);
  });

  it("stopAndWait() waits for the process to exit, then removes the PID file", async () => {
    const child = spawnSlowShutdownChild(300);
    children.push(child);
    await waitForSpawn(child);
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid));

    const stopped = await stopAndWait(await freePort(), 5_000);
    expect(stopped).toBe(true);
    // Process must be gone by the time stopAndWait resolves…
    expect(() => process.kill(child.pid!, 0)).toThrow();
    // …and only then is the PID file removed.
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });

  it("stop() cleans up a stale PID file and reports not running", async () => {
    const child = spawnSlowShutdownChild(0);
    children.push(child);
    await waitForSpawn(child);
    const deadPid = child.pid!;
    child.kill("SIGKILL");
    await waitForExit(child);

    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(deadPid));

    const stopped = stop(await freePort());
    expect(stopped).toBe(false);
    expect(fs.existsSync(PID_FILE)).toBe(false);
  });
});
