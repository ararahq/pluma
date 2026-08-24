export type ErrorCode =
  | "invalid_input"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "quota_exceeded"
  | "rate_limited"
  | "idempotency_required"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "unsafe_url"
  | "upstream_timeout"
  | "document_too_large"
  | "unsupported_pdf"
  | "scanned_pdf"
  | "render_failure"
  | "worker_unavailable"
  | "billing_unavailable"
  | "subscription_exists"
  | "misconfigured"
  | "internal_error";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly retryAfter?: number;

  constructor(code: ErrorCode, message: string, status: number, options: { details?: Record<string, unknown>; retryAfter?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = options.details;
    this.retryAfter = options.retryAfter;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError("internal_error", "An internal error occurred", 500, { cause: error });
}

export function errorBody(error: AppError, requestId: string): Record<string, unknown> {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
    request_id: requestId,
  };
}
