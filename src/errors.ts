// Structured error result shared by the read-only tools (and beyond).
// Tools return this JSON shape instead of throwing raw strings, so MCP clients
// get a stable, machine-readable failure contract.

export interface ToolErrorResult {
  ok: false;
  error_code: string;
  message: string;       // human-facing, Korean
  retryable: boolean;
  next_action?: string;  // what the caller should try next
  debug?: string;        // sanitized technical detail, never credentials
}

// Diagnostic arrays a tool may attach to a failure without a top-level message.
const NESTED_DIAGNOSTIC_KEYS = ['errors', 'partial_failures', 'results'] as const;

function nestedDiagnostics(details: Record<string, unknown>): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const key of NESTED_DIAGNOSTIC_KEYS) {
    const value = details[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const diagnostic = entry as Record<string, unknown>;
      // Batch results also contain successful and normally excluded items.
      // Only actual failures may describe the aggregate error.
      if (key === 'results' && diagnostic.status !== 'failed') continue;
      entries.push(diagnostic);
    }
  }
  return entries;
}

/** Add the common failure contract while retaining tool-specific diagnostics. */
export function normalizeToolError(value: unknown, fallbackMessage: string): ToolErrorResult & Record<string, unknown> {
  const details = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const legacyCodes: Record<string, string> = {
    not_found: 'FILE_NOT_FOUND',
    file_missing: 'FILE_MISSING',
    too_large: 'FILE_TOO_LARGE',
  };
  const errorCode = typeof details.error_code === 'string' && details.error_code
    ? details.error_code
    : typeof details.reason === 'string' && details.reason
      ? details.reason
      : typeof details.code === 'string' && details.code
        ? (Object.hasOwn(legacyCodes, details.code) ? legacyCodes[details.code] : details.code)
        : 'TOOL_ERROR';
  // Tools that report a failure through nested diagnostics (partial failures,
  // per-source issues, per-item outcomes) still need a usable top-level message
  // and retryability signal instead of the generic fallback.
  const nested = nestedDiagnostics(details);
  const nestedMessageEntry = nested.find((entry) =>
    (typeof entry.message === 'string' && entry.message.length > 0)
    || (typeof entry.reason === 'string' && entry.reason.length > 0));
  const nestedMessage = typeof nestedMessageEntry?.message === 'string' && nestedMessageEntry.message
    ? nestedMessageEntry.message
    : typeof nestedMessageEntry?.reason === 'string' && nestedMessageEntry.reason
      ? nestedMessageEntry.reason
      : undefined;
  return {
    ...details,
    ok: false,
    error_code: errorCode,
    message: typeof details.message === 'string' && details.message
      ? details.message
      : nestedMessage ?? fallbackMessage,
    retryable: typeof details.retryable === 'boolean'
      ? details.retryable
      : nested.some((entry) => entry.retryable === true),
  };
}

/**
 * Strips URLs of query/hash (which may carry tokens) and clamps length, so a
 * raw error message can be safely surfaced in the `debug` field.
 */
export function sanitizeDebug(reason: string): string {
  return reason
    .replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
      try {
        const url = new URL(raw);
        url.search = '';
        url.hash = '';
        return url.toString();
      } catch {
        return '[url]';
      }
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * Heuristic: Canvas/network errors that are worth retrying. Auth/permission/
 * not-found are not retryable.
 */
export function isRetryableReason(reason: string): boolean {
  const normalized = reason.toLowerCase();
  if (/\b(400|401|403|404|409|422)\b/.test(normalized)) return false;
  if (normalized.includes('not in allowlist')) return false;
  if (normalized.includes('invalid url')) return false;
  if (/\b(429|5\d\d)\b/.test(normalized)) return true;
  if (normalized.includes('timeout') || normalized.includes('timed out')) return true;
  if (normalized.includes('network') || normalized.includes('econnreset') || normalized.includes('etimedout')) return true;
  if (normalized.includes('net::')) return true;
  return true;
}

export function toErrorResult(
  errorCode: string,
  message: string,
  options: { err?: unknown; retryable?: boolean; nextAction?: string } = {},
): ToolErrorResult {
  const rawReason = options.err instanceof Error ? options.err.message : options.err !== undefined ? String(options.err) : '';
  const debug = rawReason ? sanitizeDebug(rawReason) : undefined;
  const retryable = options.retryable ?? (rawReason ? isRetryableReason(rawReason) : false);
  return {
    ok: false,
    error_code: errorCode,
    message,
    retryable,
    ...(options.nextAction ? { next_action: options.nextAction } : {}),
    ...(debug ? { debug } : {}),
  };
}
