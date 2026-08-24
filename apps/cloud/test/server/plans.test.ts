import { describe, expect, it } from "vitest";
import { planFromPrice, planGrantsQuota, planLimits } from "../../src/server/billing/plans.js";

describe("plans", () => {
  it("uses the canonical page-unit quotas", () => {
    expect(planLimits("developer").includedUnits).toBe(5_000);
    expect(planLimits("pro").includedUnits).toBe(50_000);
    expect(planLimits("scale").includedUnits).toBe(250_000);
  });

  it("maps only configured Stripe prices", () => {
    expect(planFromPrice("price_pro", { pro: "price_pro" })).toBe("pro");
    expect(() => planFromPrice("price_attacker", { pro: "price_pro" })).toThrow();
  });

  it("fails closed as soon as Stripe marks a subscription past due", () => {
    const now = new Date("2026-08-23T00:00:00Z");
    expect(planGrantsQuota("active", now)).toBe(true);
    expect(planGrantsQuota("trialing", now)).toBe(true);
    expect(planGrantsQuota("past_due", now, new Date("2026-09-23T00:00:00Z"))).toBe(false);
    expect(planGrantsQuota("past_due", now, new Date("2026-08-19T00:00:00Z"))).toBe(false);
  });
});
