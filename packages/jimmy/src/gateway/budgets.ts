import { initDb } from '../sessions/registry.js';

export type BudgetStatus = 'ok' | 'warning' | 'exceeded' | 'paused';

export function checkBudget(employee: string, budgetConfig: Record<string, number>): BudgetStatus {
  const db = initDb();
  const limit = budgetConfig[employee];
  if (!limit) return 'ok';

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const row = db.prepare(
    `SELECT COALESCE(SUM(total_cost), 0) as spend FROM sessions WHERE employee = ? AND created_at >= ?`
  ).get(employee, monthStart) as { spend: number };

  const percent = limit > 0 ? Math.round((row.spend / limit) * 100) : 0;

  if (percent >= 100) return 'paused';
  if (percent >= 80) return 'warning';
  return 'ok';
}
