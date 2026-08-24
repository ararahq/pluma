import { describe, expect, it } from "vitest";
import { FairAdmissionScheduler } from "../../src/server/admission.js";

describe("fair admission", () => {
  it("round-robins pending accounts", async () => {
    const scheduler = new FairAdmissionScheduler(1);
    const order: string[] = [];
    let release: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const first = scheduler.submit("a", "developer", async () => { order.push("a1"); await blocker; });
    const second = scheduler.submit("a", "developer", async () => { order.push("a2"); });
    const third = scheduler.submit("b", "developer", async () => { order.push("b1"); });
    release!();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["a1", "b1", "a2"]);
    await scheduler.close();
  });

  it("rejects overflow beyond the per-account pending depth", async () => {
    const scheduler = new FairAdmissionScheduler(1);
    let release: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const active = scheduler.submit("a", "developer", () => blocker);
    const queued = [1, 2, 3, 4].map(() => scheduler.submit("a", "developer", async () => undefined));
    await expect(scheduler.submit("a", "developer", async () => undefined)).rejects.toMatchObject({ code: "rate_limited" });
    release!();
    await Promise.all([active, ...queued]);
    await scheduler.close();
  });

  it("expires a saturated queue before an idempotency reservation can go stale", async () => {
    const scheduler = new FairAdmissionScheduler(1, 20);
    let release: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const active = scheduler.submit("a", "developer", () => blocker);
    await expect(scheduler.submit("b", "developer", async () => undefined)).rejects.toMatchObject({
      code: "upstream_timeout",
      status: 504,
    });
    release!();
    await active;
    await scheduler.close();
  });

  it("re-admits an account after its previous job became fully idle", async () => {
    const scheduler = new FairAdmissionScheduler(1, 50);
    const order: string[] = [];

    await scheduler.submit("a", "developer", async () => { order.push("first"); });
    await scheduler.submit("a", "developer", async () => { order.push("second"); });

    expect(order).toEqual(["first", "second"]);
    await scheduler.close();
  });
});
