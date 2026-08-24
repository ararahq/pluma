import type { Account, BillingState, IdempotencyClaim, Operation, Reservation, StoredResponse, UsageSnapshot } from "./types.js";

export interface StripeBillingIdentifiers {
  customerId?: string;
  subscriptionId: string | null;
  sourceSubscriptionId: string;
}

export interface BillingMutations {
  applyEvent(state: BillingState, providerUpdatedAt: Date, stripe: StripeBillingIdentifiers): Promise<boolean>;
  reconcile(state: BillingState, stripe: StripeBillingIdentifiers): Promise<boolean>;
}

export interface UsageStore {
  reserve(input: { accountId: string; plan: Account["plan"]; maximumUnits: number; expiresAt: Date }): Promise<Reservation>;
  finalize(reservationId: string, actualUnits: number): Promise<void>;
  refund(reservationId: string): Promise<void>;
  usage(accountId: string, plan: Account["plan"], now: Date): Promise<UsageSnapshot>;
}

export interface IdempotencyStore {
  claim(input: {
    accountId: string;
    route: string;
    key: string;
    requestHash: string;
    maximumUnits: number;
    plan: Account["plan"];
    expiresAt: Date;
  }): Promise<IdempotencyClaim>;
  complete(accountId: string, route: string, key: string, reservationId: string, actualUnits: number, encryptedResponse: Uint8Array): Promise<void>;
  fail(accountId: string, route: string, key: string, reservationId: string): Promise<void>;
  decryptReplay(claim: IdempotencyClaim): StoredResponse | undefined;
}

export interface AccountStore {
  byId(id: string): Promise<Account | null>;
  byUserId(userId: string): Promise<Account | null>;
  ensureForUser(userId: string): Promise<Account>;
  applyBilling(state: BillingState, providerUpdatedAt: Date, stripe: StripeBillingIdentifiers): Promise<boolean>;
  withBillingMutation?<T>(accountId: string, work: (mutations: BillingMutations) => Promise<T>): Promise<T>;
}

export interface RequestMetadataStore {
  record(input: {
    requestId: string;
    accountId: string;
    operation: Operation;
    status: "succeeded" | "failed";
    units: number;
    durationMs: number;
    warningCodes: string[];
  }): Promise<void>;
  recent(accountId: string, limit: number): Promise<Array<Record<string, unknown>>>;
}
