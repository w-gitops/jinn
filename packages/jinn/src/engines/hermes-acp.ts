// packages/jinn/src/engines/hermes-acp.ts
import { spawn, type ChildProcess } from "node:child_process";
import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { HermesRpc } from "./hermes-jsonrpc.js";
import { mapSessionUpdate, extractPromptText } from "./hermes-protocol.js";

const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const ALLOW_ALWAYS = { outcome: { outcome: "selected", optionId: "allow_always" } };

interface ProcHandle {
  rpc: HermesRpc;
  killProc: () => void;
  isAliveProc: () => boolean;
  onExit: (cb: () => void) => void;
}

interface HermesProc {
  handle: ProcHandle;
  alive: boolean;
  hermesSessionId?: string;
  currentModelId?: string;
  initialized: Promise<void>;
}

export class HermesAcpEngine implements InterruptibleEngine {
  name = "hermes" as const;
  private procs = new Map<string, HermesProc>();

  /** Test seam — overridden in unit tests to inject a fake server. */
  protected spawnProc(bin: string, cwd: string): ProcHandle {
    const child: ChildProcess = spawn(bin, ["acp"], {
      stdio: ["pipe", "pipe", "ignore"],
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, HERMES_YOLO_MODE: "1", HERMES_ACCEPT_HOOKS: "1" },
    });
    const rpc = new HermesRpc(child.stdin!, child.stdout!);
    return {
      rpc,
      killProc: () => {
        try { process.kill(-child.pid!, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* ignore */ } }
      },
      isAliveProc: () => child.exitCode === null && !child.killed,
      onExit: (cb) => child.on("exit", cb),
    };
  }

  private getOrSpawn(jinnId: string, bin: string, cwd: string): HermesProc {
    const existing = this.procs.get(jinnId);
    if (existing && existing.alive) return existing;

    const handle = this.spawnProc(bin, cwd);
    handle.rpc.onServerRequest(() => ALLOW_ALWAYS);
    const entry: HermesProc = {
      handle,
      alive: true,
      initialized: handle.rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {} }).then(() => {}),
    };
    handle.onExit(() => {
      entry.alive = false;
      handle.rpc.rejectAll(new Error("hermes acp exited"));
    });
    this.procs.set(jinnId, entry);
    return entry;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const jinnId = opts.sessionId || opts.resumeSessionId || "default";
    const bin = resolveBin("hermes", opts.bin);
    const p = this.getOrSpawn(jinnId, bin, opts.cwd);
    const { rpc } = p.handle;
    await p.initialized;

    // session/new or session/load
    if (!p.hermesSessionId) {
      if (opts.resumeSessionId) {
        await rpc.request("session/load", { sessionId: opts.resumeSessionId, cwd: opts.cwd, mcpServers: [] });
        p.hermesSessionId = opts.resumeSessionId;
      } else {
        const ns = await rpc.request<Record<string, unknown>>("session/new", { cwd: opts.cwd, mcpServers: [] });
        p.hermesSessionId = String(ns.sessionId);
        const models = ns.models as Record<string, unknown> | undefined;
        p.currentModelId = models?.currentModelId ? String(models.currentModelId) : undefined;
      }
      await rpc.request("session/set_mode", { sessionId: p.hermesSessionId, modeId: "dont_ask" }).catch(() => {});
    }

    if (opts.model && opts.model !== p.currentModelId) {
      await rpc.request("session/set_model", { sessionId: p.hermesSessionId, modelId: opts.model }).catch(() => {});
      p.currentModelId = opts.model;
    }

    let resultText = "";
    let lastContext: number | undefined;
    const hermesSessionId = p.hermesSessionId;

    const onNote = (m: string, params: Record<string, unknown>) => {
      if (m !== "session/update" || params.sessionId !== hermesSessionId) return;
      const u = mapSessionUpdate((params.update ?? {}) as Record<string, unknown>);
      for (const d of u.deltas) {
        if (d.type === "text") resultText += d.content;
        opts.onStream?.(d);
      }
      if (u.contextTokens != null) lastContext = u.contextTokens;
    };
    rpc.onNotification(onNote);

    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        rpc.request<Record<string, unknown>>("session/prompt", {
          sessionId: hermesSessionId,
          prompt: extractPromptText(opts.prompt),
        }),
        new Promise<never>((_, rej) => {
          watchdog = setTimeout(() => rej(new Error("hermes turn timeout")), TURN_TIMEOUT_MS);
          watchdog.unref?.();
        }),
      ]);

      const stop = String(res.stopReason ?? res.stop_reason ?? "");
      const error =
        !resultText && (stop === "refusal" || stop === "cancelled")
          ? `Hermes turn ended: ${stop}`
          : undefined;

      return {
        sessionId: hermesSessionId!,
        result: resultText,
        contextTokens: lastContext,
        error,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[hermes-acp] turn error for ${jinnId}: ${msg}`);
      return {
        sessionId: hermesSessionId || "",
        result: resultText,
        contextTokens: lastContext,
        error: resultText ? undefined : msg,
      };
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }

  kill(sessionId: string): void {
    const p = this.procs.get(sessionId);
    if (!p) return;
    p.alive = false;
    try { p.handle.killProc(); } catch { /* ignore */ }
    this.procs.delete(sessionId);
  }

  isAlive(sessionId: string): boolean {
    const p = this.procs.get(sessionId);
    return !!p && p.alive && p.handle.isAliveProc();
  }

  killAll(): void {
    for (const p of this.procs.values()) {
      p.alive = false;
      try { p.handle.killProc(); } catch { /* ignore */ }
    }
    this.procs.clear();
  }

  /** No shared idle pool — per-session procs recycle via kill on org reload. */
  killIdle(): void {
    /* no-op */
  }
}
