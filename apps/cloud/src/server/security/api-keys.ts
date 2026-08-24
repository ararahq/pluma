import { randomBytes, randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import type { ApiKeyRecord, Operation } from "../types.js";
import { constantTimeEqual, hmacSha256 } from "./crypto.js";

const KEY_PREFIX = "pluma_live_";

export interface ApiKeyStore {
  insert(record: ApiKeyRecord): Promise<void>;
  findByPrefix(prefix: string): Promise<ApiKeyRecord[]>;
  list(accountId: string): Promise<ApiKeyRecord[]>;
  revoke(accountId: string, keyId: string): Promise<boolean>;
  touch(keyId: string, now: Date): Promise<void>;
}

export interface IssuedApiKey {
  record: ApiKeyRecord;
  secret: string;
}

export class ApiKeyService {
  constructor(private readonly store: ApiKeyStore, private readonly pepper: string) {}

  async issue(accountId: string, name: string, scopes: Operation[] | null = null): Promise<IssuedApiKey> {
    const entropy = randomBytes(32).toString("base64url");
    const secret = `${KEY_PREFIX}${entropy}`;
    const prefix = secret.slice(0, KEY_PREFIX.length + 10);
    const record: ApiKeyRecord = {
      id: randomUUID(),
      accountId,
      prefix,
      digest: hmacSha256(secret, this.pepper),
      name,
      scopes,
      createdAt: new Date(),
    };
    await this.store.insert(record);
    return { record, secret };
  }

  async authenticate(header: string | undefined, operation?: Operation): Promise<ApiKeyRecord> {
    if (!header?.startsWith("Bearer ")) throw new AppError("unauthenticated", "A valid API key is required", 401);
    const secret = header.slice("Bearer ".length).trim();
    if (!secret.startsWith(KEY_PREFIX) || secret.length < KEY_PREFIX.length + 40) {
      throw new AppError("unauthenticated", "A valid API key is required", 401);
    }
    const prefix = secret.slice(0, KEY_PREFIX.length + 10);
    const expected = hmacSha256(secret, this.pepper);
    const records = await this.store.findByPrefix(prefix);
    const record = records.find((candidate) => !candidate.revokedAt && constantTimeEqual(candidate.digest, expected));
    if (!record) throw new AppError("unauthenticated", "A valid API key is required", 401);
    if (operation && record.scopes && !record.scopes.includes(operation)) {
      throw new AppError("forbidden", "This API key is not allowed to perform that operation", 403);
    }
    await this.store.touch(record.id, new Date());
    return record;
  }

  async revoke(accountId: string, keyId: string): Promise<void> {
    if (!(await this.store.revoke(accountId, keyId))) throw new AppError("not_found", "API key not found", 404);
  }
}
