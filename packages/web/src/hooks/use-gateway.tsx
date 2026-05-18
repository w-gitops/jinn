"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createGatewaySocket } from "@/lib/ws";

type Listener = (event: string, payload: unknown) => void;

export interface GatewayEvent {
  event: string;
  payload: unknown;
}

interface GatewayContextValue {
  events: GatewayEvent[];
  connected: boolean;
  connectionSeq: number;
  skillsVersion: number;
  subscribe: (fn: Listener) => () => void;
}

const GatewayContext = createContext<GatewayContextValue | null>(null);

/**
 * Opens ONE WebSocket per app and exposes its events via context.
 * All consumers (useGateway, NotificationProvider, etc.) read from this
 * single connection — never open their own.
 */
export function GatewayProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<GatewayEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [connectionSeq, setConnectionSeq] = useState(0);
  const [skillsVersion, setSkillsVersion] = useState(0);
  const listenersRef = useRef<Set<Listener>>(new Set());

  useEffect(() => {
    const socket = createGatewaySocket(
      (event, payload) => {
        setEvents((prev) => [...prev.slice(-99), { event, payload }]);

        if (event === "skills:changed") {
          setSkillsVersion((prev) => prev + 1);
        }

        // Dispatch to synchronous subscribers (bypasses React 18 batching)
        for (const fn of listenersRef.current) {
          fn(event, payload);
        }
      },
      {
        onOpen: () => {
          setConnected(true);
          setConnectionSeq((prev) => prev + 1);
        },
        onClose: () => {
          setConnected(false);
        },
      },
    );
    return () => socket.close();
  }, []);

  const subscribe = useCallback((fn: Listener) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  return (
    <GatewayContext.Provider
      value={{ events, connected, connectionSeq, skillsVersion, subscribe }}
    >
      {children}
    </GatewayContext.Provider>
  );
}

/**
 * Consumer hook. Returns the same shape callers already expect.
 * Does NOT open a WebSocket — that's GatewayProvider's job.
 */
export function useGateway(): GatewayContextValue {
  const ctx = useContext(GatewayContext);
  if (!ctx) {
    throw new Error(
      "useGateway must be used inside <GatewayProvider> (mounted in ClientProviders).",
    );
  }
  return ctx;
}
