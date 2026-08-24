export type Plan = "free" | "developer" | "pro" | "scale";

export type Operation = "read_url" | "read_html" | "read_pdf" | "render" | "demo_render";

export type RequestStatus = "reserved" | "running" | "succeeded" | "failed" | "cancelled";

export interface Account {
  id: string;
  userId: string;
  plan: Plan;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  subscriptionStatus?: string;
  providerUpdatedAt?: Date;
  currentPeriodEnd?: Date;
}

export interface ApiKeyRecord {
  id: string;
  accountId: string;
  prefix: string;
  digest: string;
  name: string;
  scopes: Operation[] | null;
  createdAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
}

export interface Reservation {
  id: string;
  accountId: string;
  month: string;
  maximumUnits: number;
  finalUnits?: number;
  state: "reserved" | "charged" | "refunded";
  expiresAt: Date;
}

export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface IdempotencyClaim {
  kind: "claimed" | "in_progress" | "replay" | "conflict";
  reservation?: Reservation;
  response?: StoredResponse;
}

export interface RequestPrincipal {
  account: Account;
  apiKey?: ApiKeyRecord;
  userId?: string;
}

export interface UsageSnapshot {
  month: string;
  usedUnits: number;
  reservedUnits: number;
  includedUnits: number;
  operationUnits: Record<string, number>;
}

export interface DocumentResult {
  body: Uint8Array;
  contentType: string;
  units: number;
  pageCount?: number;
  warnings: string[];
  meta?: Record<string, unknown>;
}

export interface SessionIdentity {
  userId: string;
  email?: string;
}

export interface BillingState {
  accountId: string;
  plan: Plan;
  status: string;
  currentPeriodEnd?: Date;
}
