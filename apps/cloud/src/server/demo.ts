import { AppError } from "./errors.js";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class DemoGate {
  private readonly buckets = new Map<string, Bucket>();
  private day = new Date().toISOString().slice(0, 10);
  private dailyCount = 0;

  constructor(private readonly perMinute = 5, private readonly dailyCap = 500) {}

  admit(ip: string, now = Date.now()): void {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.dailyCount = 0;
      this.buckets.clear();
    }
    if (this.dailyCount >= this.dailyCap) throw new AppError("rate_limited", "Anonymous compute cap reached for today", 429, { retryAfter: 3_600 });
    const bucket = this.buckets.get(ip) ?? { tokens: this.perMinute, updatedAt: now };
    const replenished = Math.min(this.perMinute, bucket.tokens + ((now - bucket.updatedAt) / 60_000) * this.perMinute);
    if (replenished < 1) throw new AppError("rate_limited", "Anonymous demo rate exceeded", 429, { retryAfter: 12 });
    this.buckets.set(ip, { tokens: replenished - 1, updatedAt: now });
    this.dailyCount += 1;
  }
}
