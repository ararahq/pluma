export interface SafeLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const BLOCKED_KEYS = /(?:body|content|document|markdown|pdf|html|password|secret|token|authorization|cookie|api.?key|url|query)/i;

export function sanitizeLogFields(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).flatMap(([key, value]) => {
    if (BLOCKED_KEYS.test(key)) return [];
    if (value instanceof Error) return [[key, { name: value.name, message: value.message }]];
    if (["string", "number", "boolean"].includes(typeof value) || value === null) return [[key, value]];
    return [];
  }));
}

function write(level: string, event: string, fields?: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ level, event, ...sanitizeLogFields(fields) })}\n`);
}

export const logger: SafeLogger = {
  info: (event, fields) => write("info", event, fields),
  warn: (event, fields) => write("warn", event, fields),
  error: (event, fields) => write("error", event, fields),
};
