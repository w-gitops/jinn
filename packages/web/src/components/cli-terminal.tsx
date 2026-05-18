import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { usePageVisibility } from "../hooks/use-page-visibility";

function getPtyWsUrl(sessionId: string): string {
  const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
  if (gatewayUrl) {
    return `${gatewayUrl.replace(/^http/, "ws")}/ws/pty/${sessionId}`;
  }
  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws/pty/${sessionId}`;
  }
  return `ws://127.0.0.1:7777/ws/pty/${sessionId}`;
}

/**
 * Live xterm.js view onto a session's interactive `claude` PTY, served over /ws/pty/:sessionId.
 *
 * Display-only: input flows through the parent's <ChatInput /> (rendered as a flex sibling
 * by chat-pane), which uploads attachments + POSTs to /api/sessions/:id/message with
 * `mode: "interactive"`. The API routes that to the interactive engine which injects the
 * prompt into this same warm PTY via bracketed-paste, so the user sees it appear in xterm.
 */
export function CliTerminal({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const visible = usePageVisibility();
  const [hasOutput, setHasOutput] = useState(false);
  // Mirror of `hasOutput` for use inside the WS onmessage closure, which is
  // created once per session and would otherwise see a stale `false`.
  const hasOutputRef = useRef(false);
  // A reset frame can flip hasOutput back to false; keep the ref in sync.
  const markHasOutput = (value: boolean) => {
    hasOutputRef.current = value;
    setHasOutput(value);
  };

  useEffect(() => {
    // Defensive guard — parent already gates rendering on sessionId, but if a falsy
    // value ever slips through, do nothing rather than open /ws/pty/null.
    if (!sessionId) return;
    if (!containerRef.current) return;

    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      theme: { background: "#0b0b0c" },
      scrollback: 5000,
      scrollOnUserInput: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    const wsUrl = getPtyWsUrl(sessionId);
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onmessage = (e) => {
      // Text frames carry JSON control messages from the daemon. The PTY
      // can respawn within the same session (e.g. KEEP ALIVE → daemon
      // restarts claude); when it does, the daemon emits {"type":"reset"}
      // so we can clear the previous PTY's scrollback before new bytes
      // arrive on the (binary) data path. Data is always binary.
      if (typeof e.data === "string") {
        try {
          const msg = JSON.parse(e.data);
          if (msg?.type === "reset") {
            term.reset();
            markHasOutput(false);
            return;
          }
        } catch {
          // Not JSON — fall through and treat as plain text output.
        }
        term.write(e.data);
        if (!hasOutputRef.current && e.data.length > 0) markHasOutput(true);
      } else {
        const bytes = new Uint8Array(e.data as ArrayBuffer);
        term.write(bytes);
        if (!hasOutputRef.current && bytes.byteLength > 0) markHasOutput(true);
      }
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      // Initial viewing report — backend ref-counts viewers and uses this to
      // keep the PTY warm (or auto-respawn on return if it was reaped).
      ws.send(JSON.stringify({ type: "viewing", viewing: document.visibilityState === "visible" }));
    };

    // Coalesce a burst of `resize` events (window drag, mobile rotation,
    // devtools open) into one fit + one WS frame per animation frame. Without
    // this, fit.fit() and a WS resize message fire per pixel during a drag.
    let raf: number | null = null;
    const scheduleFit = () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = null;
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      });
    };
    window.addEventListener("resize", scheduleFit);

    // ChatInput sits beside us as a flex sibling and grows when the user attaches
    // files. Without this observer the xterm container height shrinks but xterm
    // keeps its old row count — text gets clipped at the bottom.
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(containerRef.current);

    return () => {
      window.removeEventListener("resize", scheduleFit);
      ro.disconnect();
      if (raf !== null) cancelAnimationFrame(raf);
      // Explicit viewing:false before close so the backend decrements promptly
      // (close handler also decrements as a safety net, but this is cleaner).
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "viewing", viewing: false })); } catch { /* ignore */ }
      }
      ws.close();
      wsRef.current = null;
      term.dispose();
    };
  }, [sessionId]);

  // Page Visibility — emit on backgrounding/foregrounding so the backend can
  // start the 10-min grace timer (hidden) or trigger auto-resume respawn (visible).
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ type: "viewing", viewing: visible })); } catch { /* ignore */ }
  }, [visible]);

  if (!sessionId) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "#888",
          fontFamily: "monospace",
          fontSize: 13,
          padding: "1rem",
          textAlign: "center",
        }}
      >
        Send your first message to start the interactive session.
      </div>
    );
  }

  return (
    <div
      style={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        width: "100%",
        overflow: "hidden",
        background: "#0b0b0c",
        paddingTop: "1rem",
        boxSizing: "border-box",
      }}
    >
      <div ref={containerRef} style={{ height: "100%", width: "100%", overflow: "hidden", background: "#0b0b0c" }} />
      {!hasOutput && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            padding: "1rem",
            color: "#888",
            fontFamily: "monospace",
            fontSize: 12,
            pointerEvents: "none",
            textAlign: "center",
          }}
        >
          Waiting for the interactive claude PTY… send a message below to spawn it.
        </div>
      )}
    </div>
  );
}
