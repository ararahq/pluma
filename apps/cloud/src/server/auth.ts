import { betterAuth } from "better-auth";
import type { Pool } from "pg";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import type { SessionIdentity } from "./types.js";

export interface AuthProvider {
  handler(request: Request): Promise<Response>;
  session(headers: Headers): Promise<SessionIdentity | null>;
}

export function createBetterAuthProvider(pool: Pool, config: AppConfig): AuthProvider {
  if (config.environment === "production" && !config.betterAuthSecret) {
    throw new AppError("misconfigured", "BETTER_AUTH_SECRET is required in production", 500);
  }
  const github = config.githubClientId && config.githubClientSecret
    ? { github: { clientId: config.githubClientId, clientSecret: config.githubClientSecret } }
    : undefined;
  const sendEmail = async (input: { user: { email: string }; url: string }, purpose: "verify" | "reset"): Promise<void> => {
    if (!config.emailDeliveryUrl || !config.emailDeliveryToken) {
      if (config.environment === "production") throw new AppError("misconfigured", "Email delivery is unavailable", 500);
      return;
    }
    const response = await fetch(config.emailDeliveryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.emailDeliveryToken}` },
      body: JSON.stringify({ to: input.user.email, purpose, action_url: input.url }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new AppError("internal_error", "Email delivery failed", 502);
  };
  const auth = betterAuth({
    database: pool,
    baseURL: config.publicOrigin,
    secret: config.betterAuthSecret,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: config.environment === "production",
      sendResetPassword: (input) => sendEmail(input, "reset"),
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: { sendVerificationEmail: (input) => sendEmail(input, "verify"), sendOnSignUp: true },
    socialProviders: github,
    trustedOrigins: [config.publicOrigin],
    advanced: { useSecureCookies: config.environment === "production" },
    rateLimit: { enabled: true, window: 60, max: 10 },
    user: {
      modelName: "pluma_auth_users",
      fields: { emailVerified: "email_verified", createdAt: "created_at", updatedAt: "updated_at" },
    },
    session: {
      modelName: "pluma_auth_sessions",
      fields: { expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at", ipAddress: "ip_address", userAgent: "user_agent", userId: "user_id" },
    },
    account: {
      modelName: "pluma_auth_identities",
      encryptOAuthTokens: true,
      fields: {
        accountId: "identity_id", providerId: "provider_id", userId: "user_id", accessToken: "access_token",
        refreshToken: "refresh_token", idToken: "id_token", accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at", createdAt: "created_at", updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: "pluma_auth_verifications",
      fields: { expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at" },
    },
  });
  return {
    handler: (request) => auth.handler(request),
    session: async (headers) => {
      const value = await auth.api.getSession({ headers });
      if (!value?.user || typeof value.user.id !== "string") return null;
      return { userId: value.user.id, email: typeof value.user.email === "string" ? value.user.email : undefined };
    },
  };
}
