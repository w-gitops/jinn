import { describe, it, expect } from "vitest";
import { validateCard, validateCardPatch } from "../card-validate.js";

describe("validateCard", () => {
  it("accepts a valid card of each of the 8 types", () => {
    const cards: unknown[] = [
      { id: "c1", type: "text", body: "hello" },
      { id: "c2", type: "stat", value: "42", label: "users" },
      { id: "c3", type: "list", items: [{ text: "one" }, { text: "two" }] },
      { id: "c4", type: "image", src: "https://x/y.png" },
      { id: "c5", type: "image-grid", images: [{ src: "https://x/1.png" }] },
      { id: "c6", type: "status", label: "build", progress: 0.5, state: "running" },
      {
        id: "c7",
        type: "agent-activity",
        agents: [{ id: "a1", name: "Dev", role: "engineer", status: "done" }],
      },
      { id: "c8", type: "link", url: "https://x", label: "open" },
    ];
    for (const card of cards) {
      const result = validateCard(card);
      expect(result.ok, JSON.stringify(card)).toBe(true);
      if (result.ok) expect(result.card).toBe(card);
    }
  });

  it("rejects a card with a missing id", () => {
    const result = validateCard({ type: "text", body: "hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/id/);
  });

  it("rejects a card with an empty id", () => {
    expect(validateCard({ id: "", type: "text", body: "hi" }).ok).toBe(false);
  });

  it("rejects an unknown card type", () => {
    const result = validateCard({ id: "c1", type: "frobnicate" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown card type/);
  });

  it("rejects a status card with a bad state", () => {
    const result = validateCard({
      id: "c1",
      type: "status",
      label: "build",
      progress: 0.5,
      state: "exploded",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/state/);
  });

  it("rejects a list card whose items is not an array", () => {
    const result = validateCard({ id: "c1", type: "list", items: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/items/);
  });

  it("rejects a list card whose item lacks string text", () => {
    expect(validateCard({ id: "c1", type: "list", items: [{ foo: 1 }] }).ok).toBe(false);
  });

  it("rejects non-object input (null)", () => {
    expect(validateCard(null).ok).toBe(false);
  });

  it("rejects non-object input (string)", () => {
    expect(validateCard("not a card").ok).toBe(false);
  });

  it("rejects optional title that is not a string", () => {
    expect(
      validateCard({ id: "c1", type: "text", body: "hi", title: 7 }).ok,
    ).toBe(false);
  });

  // --- decision-support variants ---

  it("accepts a valid card of each decision-support type", () => {
    const cards: unknown[] = [
      { id: "d1", type: "choice", prompt: "pick", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      { id: "d2", type: "comparison", columns: ["X", "Y"], rows: [{ label: "Price", cells: ["1", "2"], highlight: 1 }] },
      { id: "d3", type: "approval", summary: "Send it?", details: [{ k: "To", v: "x@y.com" }], danger: true },
      { id: "d4", type: "keyvalue", rows: [{ k: "Uptime", v: "99%", tone: "good" }] },
      { id: "d5", type: "diff", hunks: [{ label: "cfg", before: "a", after: "b" }] },
    ];
    for (const card of cards) {
      const result = validateCard(card);
      expect(result.ok, JSON.stringify(card)).toBe(true);
    }
  });

  it("rejects a choice card with empty options", () => {
    expect(validateCard({ id: "d1", type: "choice", options: [] }).ok).toBe(false);
  });

  it("rejects a choice option missing id or label", () => {
    expect(validateCard({ id: "d1", type: "choice", options: [{ label: "A" }] }).ok).toBe(false);
    expect(validateCard({ id: "d1", type: "choice", options: [{ id: "a" }] }).ok).toBe(false);
  });

  it("rejects a comparison card with non-string cells", () => {
    const result = validateCard({
      id: "d2",
      type: "comparison",
      columns: ["X"],
      rows: [{ label: "Price", cells: [1, 2] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cells/);
  });

  it("rejects an approval card without a string summary", () => {
    expect(validateCard({ id: "d3", type: "approval" }).ok).toBe(false);
  });

  it("rejects a keyvalue row missing k or v", () => {
    expect(validateCard({ id: "d4", type: "keyvalue", rows: [{ k: "only" }] }).ok).toBe(false);
  });

  it("rejects a diff card with empty hunks", () => {
    expect(validateCard({ id: "d5", type: "diff", hunks: [] }).ok).toBe(false);
  });

  // --- nested optional fields must not fail open (white-screen guard) ---

  it("rejects an approval card with non-array details", () => {
    const r = validateCard({ id: "d3", type: "approval", summary: "ok", details: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/details/);
  });

  it("rejects an approval card whose detail item lacks string v", () => {
    expect(
      validateCard({ id: "d3", type: "approval", summary: "ok", details: [{ k: "A", v: 7 }] }).ok,
    ).toBe(false);
  });

  it("rejects a choice option with non-array meta", () => {
    const r = validateCard({
      id: "d1",
      type: "choice",
      options: [{ id: "a", label: "A", meta: "nope" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/meta/);
  });

  it("rejects a choice option with a non-string detail/badge", () => {
    expect(validateCard({ id: "d1", type: "choice", options: [{ id: "a", label: "A", detail: 7 }] }).ok).toBe(false);
    expect(validateCard({ id: "d1", type: "choice", options: [{ id: "a", label: "A", badge: {} }] }).ok).toBe(false);
  });

  it("rejects a diff hunk whose before is an object (not a string)", () => {
    const r = validateCard({ id: "d5", type: "diff", hunks: [{ label: "x", before: { a: 1 }, after: "b" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/before|after|label/);
  });
});

describe("validateCardPatch", () => {
  it("accepts an empty patch and simple scalar patches", () => {
    expect(validateCardPatch({}).ok).toBe(true);
    expect(validateCardPatch({ title: "X", badge: "DONE", progress: 0.7 }).ok).toBe(true);
    expect(validateCardPatch({ state: "done" }).ok).toBe(true);
  });

  it("rejects non-object patches", () => {
    expect(validateCardPatch(null).ok).toBe(false);
    expect(validateCardPatch([]).ok).toBe(false);
    expect(validateCardPatch("nope").ok).toBe(false);
  });

  it("rejects a malformed scalar / status patch", () => {
    expect(validateCardPatch({ title: 7 }).ok).toBe(false);
    expect(validateCardPatch({ progress: "fast" }).ok).toBe(false);
    expect(validateCardPatch({ state: "exploded" }).ok).toBe(false);
  });

  it("rejects malformed nested fields (the post-pass injection vector)", () => {
    expect(validateCardPatch({ details: "nope" }).ok).toBe(false);
    expect(validateCardPatch({ details: [{ k: "A", v: 1 }] }).ok).toBe(false);
    expect(validateCardPatch({ options: [{ id: "a", label: "A", meta: "x" }] }).ok).toBe(false);
    expect(validateCardPatch({ hunks: [{ before: { a: 1 } }] }).ok).toBe(false);
    expect(validateCardPatch({ columns: ["ok", 5] }).ok).toBe(false);
  });

  it("accepts valid nested patches (comparison or keyvalue rows)", () => {
    expect(validateCardPatch({ rows: [{ label: "P", cells: ["1", "2"] }] }).ok).toBe(true);
    expect(validateCardPatch({ rows: [{ k: "Uptime", v: "99%" }] }).ok).toBe(true);
    expect(validateCardPatch({ details: [{ k: "A", v: "B" }] }).ok).toBe(true);
  });

  it("rejects rows that are neither comparison nor keyvalue shaped", () => {
    expect(validateCardPatch({ rows: [{ nope: true }] }).ok).toBe(false);
  });
});
