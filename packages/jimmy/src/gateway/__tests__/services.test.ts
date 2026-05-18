import { describe, it, expect } from "vitest";
import { buildServiceRegistry } from "../services.js";
import type { Employee } from "../../shared/types.js";

function emp(name: string, opts: Partial<Employee> = {}): Employee {
  return {
    name,
    displayName: opts.displayName ?? name,
    department: opts.department ?? "default",
    rank: opts.rank ?? "employee",
    engine: opts.engine ?? "claude",
    model: opts.model ?? "opus",
    persona: opts.persona ?? `persona for ${name}`,
    reportsTo: opts.reportsTo,
    provides: opts.provides,
  };
}

function registry(...employees: Employee[]): Map<string, Employee> {
  const map = new Map<string, Employee>();
  for (const e of employees) map.set(e.name, e);
  return map;
}

// ═══════════════════════════════════════════════════════════════
// buildServiceRegistry
// ═══════════════════════════════════════════════════════════════

describe("buildServiceRegistry", () => {
  it("returns empty registry when no employees have provides", () => {
    const reg = registry(emp("a"), emp("b"));
    const services = buildServiceRegistry(reg);
    expect(services.size).toBe(0);
  });

  it("registers services from employees", () => {
    const reg = registry(
      emp("dev", { provides: [{ name: "code-review", description: "Review PRs" }] }),
    );
    const services = buildServiceRegistry(reg);
    expect(services.size).toBe(1);
    expect(services.get("code-review")?.provider.name).toBe("dev");
    expect(services.get("code-review")?.declaration.description).toBe("Review PRs");
  });

  it("registers multiple services from one employee", () => {
    const reg = registry(
      emp("dev", {
        provides: [
          { name: "code-review", description: "Review PRs" },
          { name: "web-dev", description: "Build web features" },
        ],
      }),
    );
    const services = buildServiceRegistry(reg);
    expect(services.size).toBe(2);
    expect(services.get("code-review")?.provider.name).toBe("dev");
    expect(services.get("web-dev")?.provider.name).toBe("dev");
  });

  it("higher-ranked employee wins on collision", () => {
    const reg = registry(
      emp("junior", { rank: "employee", provides: [{ name: "review", description: "Junior review" }] }),
      emp("senior", { rank: "senior", provides: [{ name: "review", description: "Senior review" }] }),
    );
    const services = buildServiceRegistry(reg);
    expect(services.get("review")?.provider.name).toBe("senior");
    expect(services.get("review")?.declaration.description).toBe("Senior review");
  });

  it("alphabetical wins on same-rank collision", () => {
    const reg = registry(
      emp("bob", { rank: "senior", provides: [{ name: "design", description: "Bob design" }] }),
      emp("alice", { rank: "senior", provides: [{ name: "design", description: "Alice design" }] }),
    );
    const services = buildServiceRegistry(reg);
    expect(services.get("design")?.provider.name).toBe("alice");
  });
});
