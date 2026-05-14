"use client";
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

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

export function CliTerminal({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      theme: { background: "#0b0b0c" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (!containerRef.current) return;
    term.open(containerRef.current);
    fit.fit();

    const wsUrl = getPtyWsUrl(sessionId);
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        term.write(e.data);
      } else {
        term.write(new Uint8Array(e.data as ArrayBuffer));
      }
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    const onResize = () => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      ws.close();
      term.dispose();
    };
  }, [sessionId]);

  const onSend = (text: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && text.trim()) {
      ws.send(JSON.stringify({ type: "stdin", data: text }));
    }
  };

  return (
    <div style={{ position: "relative", height: "100%" }}>
      <div ref={containerRef} style={{ height: "100%" }} />
      <CliOverlayInput onSend={onSend} />
    </div>
  );
}

function CliOverlayInput({ onSend }: { onSend: (t: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <textarea
      ref={ref}
      placeholder="Type a message…"
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (ref.current) {
            onSend(ref.current.value);
            ref.current.value = "";
          }
        }
      }}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: "5.5rem",
        background: "#0b0b0c",
        color: "#eee",
        border: "1px solid #333",
        padding: "0.5rem",
        fontFamily: "monospace",
        resize: "none",
      }}
    />
  );
}
