export interface HookPayload {
  hook_event_name: "SessionStart" | "Stop" | "StopFailure" | "PreToolUse" | "PostToolUse" | string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  last_assistant_message?: string;
  tool_name?: string;
  /** Present on StopFailure: enum — rate_limit | authentication_failed | billing_error | invalid_request | server_error | max_output_tokens | unknown */
  error?: string;
  error_details?: string;
  [k: string]: unknown;
}

type HookListener = (h: HookPayload) => void;
interface Buffered { payload: HookPayload; at: number; }

export class HookRegistry {
  private listeners = new Map<string, HookListener>();
  private buffer = new Map<string, Buffered[]>();
  constructor(private ttlMs = 30_000) {}

  register(jinnSessionId: string, listener: HookListener): void {
    this.listeners.set(jinnSessionId, listener);
    const pending = this.buffer.get(jinnSessionId);
    if (pending) {
      this.buffer.delete(jinnSessionId);
      const now = Date.now();
      for (const b of pending) {
        if (now - b.at <= this.ttlMs) listener(b.payload);
      }
    }
  }

  unregister(jinnSessionId: string): void {
    this.listeners.delete(jinnSessionId);
    this.buffer.delete(jinnSessionId);
  }

  deliver(jinnSessionId: string, payload: HookPayload): void {
    const listener = this.listeners.get(jinnSessionId);
    if (listener) { listener(payload); return; }
    const arr = this.buffer.get(jinnSessionId) ?? [];
    arr.push({ payload, at: Date.now() });
    this.buffer.set(jinnSessionId, arr);
  }
}
