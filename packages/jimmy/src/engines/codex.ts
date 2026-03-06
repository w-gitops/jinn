import { spawn } from "node:child_process";
import type { Engine, EngineRunOpts, EngineResult } from "../shared/types.js";

export class CodexEngine implements Engine {
  name = "codex" as const;

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const args: string[] = [];

    if (opts.model) args.push("--model", opts.model);

    // Codex CLI takes the prompt as the last argument
    let prompt = opts.prompt;
    if (opts.systemPrompt) {
      prompt = opts.systemPrompt + "\n\n---\n\n" + prompt;
    }
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map(a => `- ${a}`).join("\n");
    }
    args.push(prompt);

    return new Promise((resolve, reject) => {
      const proc = spawn(opts.bin || "codex", args, {
        cwd: opts.cwd,
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve({
            sessionId: opts.resumeSessionId || "",
            result: stdout.trim(),
          });
        } else {
          resolve({
            sessionId: opts.resumeSessionId || "",
            result: "",
            error: `Codex exited with code ${code}: ${stderr.slice(0, 500)}`,
          });
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn Codex CLI: ${err.message}`));
      });
    });
  }
}
