import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PID_FILE, JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import type { JinnConfig } from "../shared/types.js";
import { startGateway } from "./server.js";
import { loadConfig } from "../shared/config.js";

export async function startForeground(config: JinnConfig): Promise<void> {
  const cleanup = await startGateway(config);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      logger.info("Forced exit");
      process.exit(1);
    }
    shuttingDown = true;
    logger.info("Shutting down gateway...");

    // Force exit if graceful shutdown takes too long
    const forceTimer = setTimeout(() => {
      logger.warn("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 5000);
    forceTimer.unref();

    await cleanup();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export function startDaemon(config: JinnConfig): void {
  const __filename = fileURLToPath(import.meta.url);
  const candidateEntryScripts = [
    // When running from a built bundle, __filename is dist/src/gateway/lifecycle.js
    path.resolve(path.dirname(__filename), "daemon-entry.js"),
    // Fallback for unusual layouts
    path.resolve(path.dirname(__filename), "..", "..", "dist", "src", "gateway", "daemon-entry.js"),
  ];
  const entryScript = candidateEntryScripts.find((p) => fs.existsSync(p)) ?? candidateEntryScripts[0];

  const child = spawn(process.execPath, [entryScript], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, JINN_HOME },
  });

  if (child.pid) {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid));
    logger.info(`Gateway daemon started with PID ${child.pid}`);
  }

  child.unref();
}

/**
 * Restart the gateway from a DETACHED, reparented helper process.
 *
 * The whole point: a `jinn stop && jinn start` run from *inside* a gateway
 * session fails because `stop` kills the gateway, whose shutdown kills all PTYs
 * — including the very session running the command — so `start` never executes.
 * This spawns a helper (restart-entry.js) detached + unref'd with no IPC, so it
 * is reparented to launchd/init and SURVIVES the gateway's killAll(). The
 * helper does stop → waitForPortFree → startDaemon out of band. The returning
 * gateway then resumes the interrupted session.
 */
export function restartDetached(): void {
  const __filename = fileURLToPath(import.meta.url);
  const candidateEntryScripts = [
    path.resolve(path.dirname(__filename), "restart-entry.js"),
    path.resolve(path.dirname(__filename), "..", "..", "dist", "src", "gateway", "restart-entry.js"),
  ];
  const entryScript = candidateEntryScripts.find((p) => fs.existsSync(p)) ?? candidateEntryScripts[0];

  const child = spawn(process.execPath, [entryScript], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, JINN_HOME },
  });

  if (child.pid) {
    logger.info(`Gateway restart helper started with PID ${child.pid}`);
  }

  child.unref();
}

export function stop(port?: number): boolean {
  // Try PID file first
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);

    try {
      process.kill(pid, "SIGTERM");
      logger.info(`Sent SIGTERM to gateway process ${pid}`);
      fs.unlinkSync(PID_FILE);
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        logger.warn(`Process ${pid} not found. Cleaning up stale PID file.`);
        fs.unlinkSync(PID_FILE);
      } else {
        throw err;
      }
    }
    // PID file existed but was stale; fall through to kill by port.
  }

  // No PID file — try to kill whatever is listening on the port
  const targetPort = port ?? resolvePort();
  const pid = findPidOnPort(targetPort);
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      logger.info(`Killed process ${pid} on port ${targetPort}`);
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        logger.warn(`Process ${pid} already gone.`);
        return true;
      }
      throw err;
    }
  }

  logger.warn(`No PID file found and nothing listening on port ${targetPort}.`);
  return false;
}

function resolvePort(): number {
  try {
    const config = loadConfig();
    return config.gateway?.port || 7777;
  } catch {
    return 7777;
  }
}

function findPidOnPort(port: number): number | null {
  try {
    if (process.platform === "win32") {
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: "utf-8" }).trim();
      if (!output) return null;
      // netstat output: proto  local_addr  foreign_addr  state  PID
      const parts = output.split("\n")[0].trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);
      return isNaN(pid) ? null : pid;
    } else {
      const output = execSync(
        process.platform === "darwin"
          ? `/usr/sbin/lsof -ti tcp:${port}`
          : `lsof -ti tcp:${port}`,
        { encoding: "utf-8" },
      ).trim();
      if (!output) return null;
      const pid = parseInt(output.split("\n")[0], 10);
      return isNaN(pid) ? null : pid;
    }
  } catch {
    return null;
  }
}

/**
 * Poll until nothing is listening on `port`, or `timeoutMs` elapses.
 * Returns true if the port became free, false on timeout (caller should start
 * anyway — startGateway will surface EADDRINUSE if it's still bound). This is
 * the race-killer: it prevents a fresh daemon from racing the old one's
 * graceful shutdown (up to 5s) into an EADDRINUSE crash.
 */
export async function waitForPortFree(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (findPidOnPort(port) === null) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

export async function waitForPortListening(port: number, host = "127.0.0.1", timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ port, host });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export interface GatewayStatus {
  running: boolean;
  pid: number | null;
}

export function getStatus(): GatewayStatus {
  const targetPort = resolvePort();

  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0);
      return { running: true, pid };
    } catch {
      // Process not alive, stale PID file — fall back to port check.
      const portPid = findPidOnPort(targetPort);
      if (portPid) return { running: true, pid: portPid };
      return { running: false, pid };
    }
  }

  const portPid = findPidOnPort(targetPort);
  if (portPid) return { running: true, pid: portPid };
  return { running: false, pid: null };
}
