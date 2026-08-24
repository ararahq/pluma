import { AppError } from "./errors.js";
import { planLimits } from "./billing/plans.js";
import type { Plan } from "./types.js";

interface Pending<T> {
  accountId: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  timeout: ReturnType<typeof setTimeout>;
}

interface RateWindow {
  startedAt: number;
  count: number;
}

export interface AdmissionPermit {
  marker: symbol;
  accountId: string;
  plan: Plan;
  used: boolean;
}

export class FairAdmissionScheduler {
  private readonly queues = new Map<string, Pending<unknown>[]>();
  private readonly activeByAccount = new Map<string, number>();
  private readonly plans = new Map<string, Plan>();
  private readonly rate = new Map<string, RateWindow>();
  private accountOrder: string[] = [];
  private lastServedAccount?: string;
  private activeGlobal = 0;
  private accepting = true;

  private readonly permitMarker = Symbol("pluma-admission");

  constructor(private readonly globalConcurrency: number, private readonly queueTimeoutMs = 60_000) {}

  preflight(accountId: string, plan: Plan): AdmissionPermit {
    if (!this.accepting) throw new AppError("worker_unavailable", "Server is shutting down", 503);
    if (plan === "free") throw new AppError("quota_exceeded", "A paid plan is required for hosted document operations", 429);
    this.checkRate(accountId, plan);
    return { marker: this.permitMarker, accountId, plan, used: false };
  }

  submit<T>(accountId: string, plan: Plan, run: () => Promise<T>, signal?: AbortSignal, permit?: AdmissionPermit): Promise<T> {
    if (!this.accepting) return Promise.reject(new AppError("worker_unavailable", "Server is shutting down", 503));
    if (signal?.aborted) return Promise.reject(new AppError("worker_unavailable", "Queued request was cancelled", 499));
    if (permit) this.consumePermit(permit, accountId, plan); else this.checkRate(accountId, plan);
    const limits = planLimits(plan);
    const queue = this.queues.get(accountId) ?? [];
    if (queue.length >= limits.pendingDepth) return Promise.reject(new AppError("rate_limited", "Account queue is full", 429, { retryAfter: 2 }));
    this.plans.set(accountId, plan);
    if (!this.queues.has(accountId)) {
      this.queues.set(accountId, queue);
      this.accountOrder.push(accountId);
    }
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = queue.indexOf(pending as Pending<unknown>);
        if (index < 0) return;
        queue.splice(index, 1);
        reject(new AppError("upstream_timeout", "Request expired while waiting for a document worker", 504));
        this.removeEmptyQueues();
      }, this.queueTimeoutMs);
      const pending: Pending<T> = { accountId, run, resolve, reject, signal, timeout };
      const abort = (): void => {
        const index = queue.indexOf(pending as Pending<unknown>);
        if (index >= 0) queue.splice(index, 1);
        clearTimeout(timeout);
        reject(new AppError("worker_unavailable", "Queued request was cancelled", 499));
      };
      signal?.addEventListener("abort", abort, { once: true });
      queue.push(pending as Pending<unknown>);
      this.drain();
    });
  }

  private checkRate(accountId: string, plan: Plan): void {
    const now = Date.now();
    const limit = planLimits(plan).requestsPerMinute;
    const window = this.rate.get(accountId);
    if (!window || now - window.startedAt >= 60_000) {
      this.rate.set(accountId, { startedAt: now, count: 1 });
      return;
    }
    if (window.count >= limit) throw new AppError("rate_limited", "Request rate exceeded", 429, { retryAfter: Math.max(1, Math.ceil((60_000 - (now - window.startedAt)) / 1_000)) });
    window.count += 1;
  }

  private drain(): void {
    while (this.activeGlobal < this.globalConcurrency && this.accountOrder.length > 0) {
      const selected = this.nextEligible();
      if (!selected) return;
      const queue = this.queues.get(selected)!;
      const pending = queue.shift()!;
      clearTimeout(pending.timeout);
      if (pending.signal?.aborted) {
        pending.reject(new AppError("worker_unavailable", "Queued request was cancelled", 499));
        continue;
      }
      this.activeGlobal += 1;
      this.activeByAccount.set(selected, (this.activeByAccount.get(selected) ?? 0) + 1);
      void pending.run().then(pending.resolve, pending.reject).finally(() => {
        this.activeGlobal -= 1;
        this.activeByAccount.set(selected, Math.max(0, (this.activeByAccount.get(selected) ?? 1) - 1));
        this.removeEmptyQueues();
        this.drain();
      });
    }
  }

  private consumePermit(permit: AdmissionPermit, accountId: string, plan: Plan): void {
    if (permit.marker !== this.permitMarker || permit.used || permit.accountId !== accountId || permit.plan !== plan) {
      throw new AppError("internal_error", "Admission permit is invalid", 500);
    }
    permit.used = true;
  }

  private nextEligible(): string | undefined {
    const lastIndex = this.lastServedAccount ? this.accountOrder.indexOf(this.lastServedAccount) : -1;
    const start = lastIndex >= 0 ? (lastIndex + 1) % this.accountOrder.length : 0;
    for (let scanned = 0; scanned < this.accountOrder.length; scanned += 1) {
      const index = (start + scanned) % this.accountOrder.length;
      const accountId = this.accountOrder[index]!;
      const queue = this.queues.get(accountId);
      const plan = this.plans.get(accountId)!;
      if (queue?.length && (this.activeByAccount.get(accountId) ?? 0) < planLimits(plan).activeJobs) {
        this.lastServedAccount = accountId;
        return accountId;
      }
    }
    return undefined;
  }

  private removeEmptyQueues(): void {
    this.accountOrder = this.accountOrder.filter((accountId) => {
      const keep = (this.queues.get(accountId)?.length ?? 0) > 0 || (this.activeByAccount.get(accountId) ?? 0) > 0;
      if (!keep) {
        // submit() uses Map membership to decide whether an account must be
        // added to the round-robin order. Keeping an idle empty queue here
        // would strand the account's next request until its queue timeout.
        this.queues.delete(accountId);
        this.plans.delete(accountId);
        this.activeByAccount.delete(accountId);
      }
      return keep;
    });
    if (this.accountOrder.length === 0) this.lastServedAccount = undefined;
  }

  async close(): Promise<void> {
    this.accepting = false;
    for (const queue of this.queues.values()) {
      for (const pending of queue.splice(0)) {
        clearTimeout(pending.timeout);
        pending.reject(new AppError("worker_unavailable", "Server is shutting down", 503));
      }
    }
    const deadline = Date.now() + 30_000;
    while (this.activeGlobal > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
