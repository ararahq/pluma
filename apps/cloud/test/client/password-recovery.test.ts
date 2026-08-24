import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/client/lib/api.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("password recovery API", () => {
  it("requests a non-enumerating Better Auth reset email", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: true, message: "Check your inbox" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    await api.requestPasswordReset("dev@example.com", "https://pluma.example/reset-password");
    expect(fetch).toHaveBeenCalledWith("/api/auth/request-password-reset", expect.objectContaining({
      method: "POST", credentials: "include",
      body: JSON.stringify({ email: "dev@example.com", redirectTo: "https://pluma.example/reset-password" }),
    }));
  });

  it("submits the Better Auth token with the new password", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    await api.resetPassword("new-password", "reset-token");
    expect(fetch).toHaveBeenCalledWith("/api/auth/reset-password", expect.objectContaining({
      method: "POST", body: JSON.stringify({ newPassword: "new-password", token: "reset-token" }),
    }));
  });
});
