import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildContext, buildTalkThreadsSection } from "../context.js";
import type { Employee, JinnConfig } from "../../shared/types.js";

// These tests lock the CURRENT output of buildContext after the "context hygiene"
// refactor: the static COO operating-manual base was dropped (engines auto-ingest
// CLAUDE.md/AGENTS.md), buildDelegationProtocol was deleted, the COO identity is a
// slim 3-line anchor, and the self-evolution block is onboarding-only.

const baseOpts = {
  source: "slack",
  channel: "C123",
  user: "Alex",
};

const minimalEmployee: Employee = {
  name: "content-lead",
  displayName: "Content Lead",
  department: "content",
  rank: "manager",
  engine: "claude",
  model: "opus",
  persona: "You lead the content team.",
};

describe("buildContext — COO (no employee)", () => {
  it("emits the slim COO identity anchor and points at the operating manual", () => {
    const out = buildContext({ ...baseOpts });
    // Slim 3-line identity anchor (default portalName = "Jinn")
    expect(out).toContain("# You are Jinn");
    expect(out).toContain("COO of the user's AI organization");
    // Anchor points at the auto-loaded manual rather than duplicating it
    expect(out).toContain("CLAUDE.md");
    expect(out).toContain("AGENTS.md");
  });

  it("includes the Current session section", () => {
    const out = buildContext({ ...baseOpts });
    expect(out).toContain("## Current session");
  });

  it("does NOT inline the removed static operating manual / delegation protocol", () => {
    const out = buildContext({ ...baseOpts });
    // The long static base prose is gone — these markers must not appear.
    expect(out).not.toContain("Core Principles");
    expect(out).not.toContain("Delegation protocol");
    expect(out).not.toContain("## Delegation");
  });

  it("does not emit the employee identity section in COO mode", () => {
    const out = buildContext({ ...baseOpts });
    expect(out).not.toContain("You are an AI employee in the");
    expect(out).not.toContain("## Your persona");
  });
});

describe("buildContext — employee mode", () => {
  it("emits the employee identity section instead of the COO anchor", () => {
    const out = buildContext({ ...baseOpts, employee: minimalEmployee });
    expect(out).toContain("# You are Content Lead");
    expect(out).toContain("You are an AI employee in the Jinn gateway system.");
    expect(out).toContain("## Your persona");
    expect(out).toContain("You lead the content team.");
    // The employee section carries the role block, not the COO "manual" anchor.
    expect(out).toContain("**Department**: content");
    expect(out).toContain("**Rank**: manager");
    // The COO-only anchor wording must NOT appear for an employee.
    expect(out).not.toContain("COO of the user's AI organization");
  });
});

describe("buildContext — voice orchestrator persona (source:talk)", () => {
  const MARKER = "You are AURA, the hands-free voice layer.";

  it("injects the voice persona when voicePersona is provided", () => {
    const out = buildContext({ ...baseOpts, voicePersona: MARKER });
    expect(out).toContain(MARKER);
    // Still keeps the base COO identity (gateway/delegation know-how) underneath.
    expect(out).toContain("# You are Jinn");
  });

  it("omits the voice persona for normal sessions", () => {
    const out = buildContext({ ...baseOpts });
    expect(out).not.toContain(MARKER);
  });
});

describe("buildContext — Current session reflects passed opts", () => {
  it("reflects sessionId, channel and user", () => {
    const out = buildContext({
      ...baseOpts,
      sessionId: "sess-abc-123",
      user: "Operator Bob",
    });
    expect(out).toContain("- Session ID: sess-abc-123");
    expect(out).toContain("- User: Operator Bob");
    expect(out).toContain("C123");
  });

  it("renders a named channel when channelName is provided", () => {
    const out = buildContext({
      ...baseOpts,
      channel: "C999",
      channelName: "ventures",
    });
    expect(out).toContain("- Channel: #ventures (C999)");
  });

  it("labels a slack DM channel", () => {
    const out = buildContext({
      ...baseOpts,
      source: "slack",
      channel: "D456",
    });
    expect(out).toContain("- Channel: Direct Message (D456)");
  });
});

describe("buildContext — config awareness", () => {
  it("emits the configuration section reflecting the passed config", () => {
    const config = {
      gateway: { host: "127.0.0.1", port: 7799 },
      engines: { default: "claude", claude: { model: "opus" } },
    } as unknown as JinnConfig;
    const out = buildContext({ ...baseOpts, config });
    expect(out).toContain("## Current configuration");
    expect(out).toContain("- Default engine: claude");
    expect(out).toContain("http://127.0.0.1:7799");
  });

  it("omits the configuration section when no config is passed", () => {
    const out = buildContext({ ...baseOpts });
    expect(out).not.toContain("## Current configuration");
  });
});

describe("buildContext — onboarding block is omitted when portal setup is complete", () => {
  // Gate is portal.setupComplete === true, with portal.onboarded === true accepted for legacy wizard completions.
  const minConfig = {
    gateway: { host: "127.0.0.1", port: 7799 },
    engines: { default: "claude" },
    portal: { setupComplete: true },
  } as unknown as JinnConfig;

  it("does not emit the onboarding block when portal.setupComplete is true", () => {
    const out = buildContext({ ...baseOpts, config: minConfig });
    expect(out).not.toContain("## Onboarding mode");
  });

  it("does not emit the onboarding block for legacy configs with portal.onboarded true", () => {
    const config = {
      gateway: { host: "127.0.0.1", port: 7799 },
      engines: { default: "claude" },
      portal: { onboarded: true },
    } as unknown as JinnConfig;
    const out = buildContext({ ...baseOpts, config });
    expect(out).not.toContain("## Onboarding mode");
  });

  it("never emits onboarding in employee mode", () => {
    const out = buildContext({ ...baseOpts, employee: minimalEmployee });
    expect(out).not.toContain("## Onboarding mode");
  });
});

describe("buildContext — onboarding block appears when portal.setupComplete is not set", () => {
  // When config is absent or both setupComplete/onboarded are falsy, the operator-aware onboarding directive is injected.
  it("emits onboarding block when portal.setupComplete is not set", () => {
    const out = buildContext({ ...baseOpts });
    expect(out).toContain("## Onboarding mode");
    expect(out).toMatch(/fresh .* install|NOT yet completed onboarding/i);
  });

  it("omits onboarding block when portal.setupComplete is true", () => {
    const config = {
      gateway: { host: "127.0.0.1", port: 7799 },
      engines: { default: "claude" },
      portal: { setupComplete: true },
    } as unknown as JinnConfig;
    const out = buildContext({ ...baseOpts, config });
    expect(out).not.toContain("## Onboarding mode");
  });
});

describe("buildContext — compact org roster", () => {
  const emp = (name: string, rank: Employee["rank"], persona: string): Employee => ({
    name, displayName: name, department: "eng", rank, engine: "claude", model: "opus", persona,
  });
  const hierarchy = {
    nodes: {
      lead: { employee: emp("lead", "manager", "Secret persona preview text"), parentName: null, directReports: ["dev"], depth: 0, chain: [] },
      dev: { employee: emp("dev", "employee", "Another secret persona"), parentName: "lead", directReports: [], depth: 1, chain: ["lead"] },
    },
    sorted: ["lead", "dev"],
  } as any;

  it("lists name/dept/rank but NOT persona previews", () => {
    const out = buildContext({ ...baseOpts, hierarchy });
    expect(out).toContain("## Organization (2 employee(s))");
    expect(out).toContain("- **lead** (lead) — eng, manager");
    expect(out).not.toContain("Secret persona preview");
    expect(out).not.toContain("Another secret persona");
  });

  it("points at the employee-detail endpoint for full personas", () => {
    const out = buildContext({ ...baseOpts, hierarchy });
    expect(out).toContain("GET /api/org/employees/:name");
  });
});

describe("buildContext — audience scoping", () => {
  const worker: Employee = { ...minimalEmployee, name: "writer", displayName: "Writer", rank: "employee" };
  const hierarchy = {
    nodes: {
      "content-lead": { employee: minimalEmployee, parentName: null, directReports: ["writer"], depth: 0, chain: [] },
      writer: { employee: worker, parentName: "content-lead", directReports: [], depth: 1, chain: ["content-lead"] },
    },
    sorted: ["content-lead", "writer"],
  } as any;

  it("employee sessions get NO org roster and NO cron list", () => {
    const out = buildContext({ ...baseOpts, employee: worker, hierarchy });
    expect(out).not.toContain("## Organization");
    expect(out).not.toContain("## Scheduled cron");
    // Chain of command (their slice of the org) stays.
    expect(out).toContain("## Chain of command");
  });

  it("COO sessions still get the org roster", () => {
    const out = buildContext({ ...baseOpts, hierarchy });
    expect(out).toContain("## Organization (2 employee(s))");
  });

  it("COO API section is a pointer at CLAUDE.md, not the full table", () => {
    const out = buildContext({ ...baseOpts });
    expect(out).toContain("Gateway API");
    expect(out).not.toContain("| `/api/cron` | GET |"); // table rows gone
    expect(out).toContain("CLAUDE.md");
  });

  it("manager employees get the delegation mini-reference", () => {
    const out = buildContext({ ...baseOpts, employee: minimalEmployee, hierarchy });
    expect(out).toContain("Delegate to another employee");
    expect(out).toContain("/api/sessions/:id/message");
    expect(out).toContain("/attachments");
    expect(out).not.toContain("| `/api/cron` | GET |");
  });

  it("non-manager employees get attachments only — no delegation endpoints", () => {
    const out = buildContext({ ...baseOpts, employee: worker, hierarchy });
    expect(out).toContain("/attachments");
    expect(out).not.toContain("Delegate to another employee");
  });

  it("connector section is slim — recipe details live in CLAUDE.md", () => {
    const out = buildContext({ ...baseOpts, connectors: ["slack"] });
    expect(out).toContain("## Available connectors: slack");
    expect(out).toContain("/api/connectors/<name>/send");
    // The old per-connector recipe block is gone:
    expect(out).not.toContain("**Send threaded reply**");
  });

  it("senior WITHOUT reports gets no delegation mini-ref", () => {
    const senior: Employee = { ...minimalEmployee, name: "analyst", displayName: "Analyst", rank: "senior" };
    const out = buildContext({ ...baseOpts, employee: senior, hierarchy });
    expect(out).not.toContain("Delegate to another employee");
  });

  it("senior WITH direct reports gets the delegation mini-ref", () => {
    const seniorLead: Employee = { ...minimalEmployee, name: "ventures-lead", displayName: "Ventures Lead", rank: "senior" };
    const h = {
      nodes: {
        "ventures-lead": { employee: seniorLead, parentName: null, directReports: ["scout"], depth: 0, chain: [] },
        scout: { employee: { ...minimalEmployee, name: "scout", displayName: "Scout", rank: "employee" }, parentName: "ventures-lead", directReports: [], depth: 1, chain: ["ventures-lead"] },
      },
      sorted: ["ventures-lead", "scout"],
    } as any;
    const out = buildContext({ ...baseOpts, employee: seniorLead, hierarchy: h });
    expect(out).toContain("Delegate to another employee");
  });

  it("chain of command carries slugs for delegation", () => {
    const out = buildContext({ ...baseOpts, employee: minimalEmployee, hierarchy });
    expect(out).toContain("`writer`"); // direct report slug
  });
});

describe("buildContext — maxChars trimming", () => {
  it("stays within a configured maxChars cap by trimming optional/standard sections", () => {
    const cap = 1200;
    const config = {
      gateway: { host: "127.0.0.1", port: 7777 },
      engines: { default: "claude", claude: { model: "opus" } },
      context: { maxChars: cap },
    } as unknown as JinnConfig;
    const out = buildContext({
      ...baseOpts,
      config,
      connectors: ["slack"],
    });
    // Trimming is best-effort by tier; the essential identity + session must survive.
    expect(out).toContain("# You are Jinn");
    expect(out).toContain("## Current session");
    // It should be dramatically smaller than the untrimmed (no-cap) output.
    const uncapped = buildContext({ ...baseOpts, connectors: ["slack"] });
    expect(out.length).toBeLessThan(uncapped.length);
  });

  it("does not trim when output is under the default cap", () => {
    const out = buildContext({ ...baseOpts });
    expect(out.length).toBeLessThan(100_000);
    // Essential sections present and intact.
    expect(out).toContain("# You are Jinn");
    expect(out).toContain("## Current session");
  });
});

describe("buildTalkThreadsSection", () => {
  it("renders a compact roster with delegate usage", () => {
    const s = buildTalkThreadsSection([
      { id: "abc123", label: "Content pipeline", status: "running", lastActivity: "2026-06-10T08:00:00Z" },
      { id: "def456", label: "Support order", status: "idle", lastActivity: "2026-06-10T07:00:00Z" },
    ]);
    expect(s).toContain("## Your open COO threads");
    expect(s).toContain("abc123");
    expect(s).toContain("Content pipeline");
    expect(s).toContain("running");
    expect(s).toContain("/api/talk/delegate");
  });
  it("returns null for empty/undefined", () => {
    expect(buildTalkThreadsSection([])).toBeNull();
    expect(buildTalkThreadsSection(undefined)).toBeNull();
  });
});
