import type { Employee, ServiceDeclaration } from "../shared/types.js";
import { logger } from "../shared/logger.js";

export interface ServiceEntry {
  provider: Employee;
  declaration: ServiceDeclaration;
}

/**
 * Build a service registry from the org employee map.
 * If two employees provide the same service, the higher-ranked one wins.
 * Ties broken alphabetically by name.
 */
export function buildServiceRegistry(
  employees: Map<string, Employee>,
): Map<string, ServiceEntry> {
  const RANK_PRIORITY: Record<string, number> = {
    executive: 0,
    manager: 1,
    senior: 2,
    employee: 3,
  };

  const registry = new Map<string, ServiceEntry>();

  for (const [, emp] of employees) {
    if (!emp.provides) continue;
    for (const decl of emp.provides) {
      const existing = registry.get(decl.name);
      if (existing) {
        const existingRank = RANK_PRIORITY[existing.provider.rank] ?? 3;
        const newRank = RANK_PRIORITY[emp.rank] ?? 3;
        if (newRank < existingRank || (newRank === existingRank && emp.name < existing.provider.name)) {
          logger.info(`Service "${decl.name}": "${emp.name}" overrides "${existing.provider.name}" (higher rank or alphabetical)`);
          registry.set(decl.name, { provider: emp, declaration: decl });
        } else {
          logger.info(`Service "${decl.name}": "${existing.provider.name}" retained over "${emp.name}"`);
        }
      } else {
        registry.set(decl.name, { provider: emp, declaration: decl });
      }
    }
  }

  return registry;
}
