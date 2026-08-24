import { AppError } from "../errors.js";
import type { Plan } from "../types.js";

export interface PlanLimits {
  includedUnits: number;
  activeJobs: number;
  requestsPerMinute: number;
  pendingDepth: number;
}

const LIMITS: Readonly<Record<Plan, PlanLimits>> = {
  free: { includedUnits: 0, activeJobs: 0, requestsPerMinute: 0, pendingDepth: 0 },
  developer: { includedUnits: 5_000, activeJobs: 2, requestsPerMinute: 60, pendingDepth: 4 },
  pro: { includedUnits: 50_000, activeJobs: 10, requestsPerMinute: 300, pendingDepth: 20 },
  scale: { includedUnits: 250_000, activeJobs: 30, requestsPerMinute: 1_000, pendingDepth: 60 },
};

export function planLimits(plan: Plan, quotaOverrides?: Partial<Record<Exclude<Plan, "free">, number>>): PlanLimits {
  const base = LIMITS[plan];
  if (plan === "free") return base;
  return { ...base, includedUnits: quotaOverrides?.[plan] ?? base.includedUnits };
}

export function planFromPrice(priceId: string, prices: Partial<Record<Exclude<Plan, "free">, string>>): Exclude<Plan, "free"> {
  const entry = Object.entries(prices).find(([, configured]) => configured === priceId);
  if (!entry || entry[0] === "free") throw new AppError("invalid_input", "Stripe price is not mapped to a Pluma plan", 400);
  return entry[0] as Exclude<Plan, "free">;
}

export function planGrantsQuota(status: string, _now?: Date, _periodEnd?: Date): boolean {
  return status === "active" || status === "trialing";
}
