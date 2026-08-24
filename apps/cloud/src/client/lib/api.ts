export type PlanId = "open-source" | "developer" | "pro" | "scale";

export type SessionUser = {
  id: string;
  name?: string | null;
  email: string;
};

export type Session = {
  user: SessionUser;
  expiresAt?: string;
};

export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes?: string[];
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
};

export type UsageSnapshot = {
  plan: PlanId;
  used: number;
  limit: number;
  resetsAt: string;
  operationUnits?: Partial<Record<"render" | "read_pdf" | "read_html" | "read_url", number>>;
};

export type RequestRecord = {
  id: string;
  operation: "render" | "read_pdf" | "read_html" | "read_url";
  status: "succeeded" | "failed" | "queued" | "running";
  units: number;
  durationMs?: number | null;
  createdAt: string;
};

export type DashboardData = {
  account: {
    plan: PlanId;
    email?: string;
    billingStatus?: "none" | "trialing" | "active" | "past_due" | "canceled";
  };
  usage: UsageSnapshot;
  apiKeys: ApiKey[];
  recentRequests: RequestRecord[];
};

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;

  constructor(message: string, status: number, code?: string, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

type JsonError = {
  error?: { code?: string; message?: string } | string;
  message?: string;
  request_id?: string;
};

async function parseError(response: Response): Promise<ApiError> {
  let body: JsonError | undefined;
  try {
    body = (await response.json()) as JsonError;
  } catch {
    body = undefined;
  }

  const nested = typeof body?.error === "object" ? body.error : undefined;
  const message =
    nested?.message ||
    (typeof body?.error === "string" ? body.error : undefined) ||
    body?.message ||
    `Request failed with status ${response.status}`;

  return new ApiError(
    message,
    response.status,
    nested?.code,
    body?.request_id || response.headers.get("X-Pluma-Request-Id") || undefined,
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "include",
      ...init,
      headers,
    });
  } catch {
    throw new ApiError("Pluma Cloud is not reachable. Check the server and try again.", 0, "unreachable");
  }

  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function bearer(key: string): HeadersInit {
  return { Authorization: `Bearer ${key}` };
}

export const api = {
  async demoRender(markdown: string): Promise<{ blob: Blob; requestId?: string; units?: number }> {
    let response: Response;
    try {
      response = await fetch("/api/demo/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown }),
      });
    } catch {
      throw new ApiError("The demo renderer is not reachable right now.", 0, "unreachable");
    }
    if (!response.ok) throw await parseError(response);
    return {
      blob: await response.blob(),
      requestId: response.headers.get("X-Pluma-Request-Id") || undefined,
      units: Number(response.headers.get("X-Pluma-Units")) || undefined,
    };
  },

  session: () => request<Session | null>("/api/auth/get-session"),

  signIn: (email: string, password: string) =>
    request<{ user?: SessionUser }>("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  signUp: (name: string, email: string, password: string) =>
    request<{ user?: SessionUser }>("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ name, email, password }),
    }),

  signInGitHub: (callbackURL = "/dashboard") =>
    request<{ url?: string; redirect?: boolean }>("/api/auth/sign-in/social", {
      method: "POST",
      body: JSON.stringify({ provider: "github", callbackURL }),
    }),

  requestPasswordReset: (email: string, redirectTo: string) =>
    request<{ status: boolean; message: string }>("/api/auth/request-password-reset", {
      method: "POST",
      body: JSON.stringify({ email, redirectTo }),
    }),

  resetPassword: (newPassword: string, token: string) =>
    request<{ status: boolean }>("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ newPassword, token }),
    }),

  signOut: () => request<void>("/api/auth/sign-out", { method: "POST" }),

  dashboard: () => request<DashboardData>("/api/dashboard"),

  createApiKey: (name: string) =>
    request<{ key: ApiKey; secret: string }>("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  revokeApiKey: (id: string) => request<void>(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" }),

  startCheckout: (plan: Exclude<PlanId, "open-source">) =>
    request<{ url: string }>("/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ plan }),
    }),

  billingPortal: () => request<{ url: string }>("/api/billing/portal", { method: "POST" }),

  renderWithKey: async (key: string, markdown: string): Promise<Blob> => {
    const response = await fetch("/v1/render", {
      method: "POST",
      headers: {
        ...bearer(key),
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""),
      },
      body: JSON.stringify({ markdown }),
    });
    if (!response.ok) throw await parseError(response);
    return response.blob();
  },
};

export function isConfigurationError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 0 || error.status === 404 || error.status === 501 || error.status === 502 || error.status === 503 || error.code === "not_configured")
  );
}
