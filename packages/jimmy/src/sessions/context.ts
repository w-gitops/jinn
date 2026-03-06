import type { Employee } from "../shared/types.js";

export function buildContext(opts: {
  source: string;
  channel: string;
  thread?: string;
  user: string;
  employee?: Employee;
}): string {
  let ctx = `You are Jimmy, a personal AI assistant.\n`;
  ctx += `Session source: ${opts.source}, channel: ${opts.channel}`;
  if (opts.thread) ctx += `, thread: ${opts.thread}`;
  ctx += `\nUser: ${opts.user}\n`;

  if (opts.employee) {
    ctx = opts.employee.persona + `\n\nSession source: ${opts.source}, channel: ${opts.channel}\nUser: ${opts.user}\n`;
  }

  return ctx;
}
