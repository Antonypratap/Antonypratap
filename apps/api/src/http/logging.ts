import { pino, type DestinationStream, type Logger } from 'pino';
import type { Environment } from '../config';

/**
 * Structured JSON logs (Phase 6). One line per request (id, method, route, status, duration) and
 * one per job outcome (job id, invoice id, safe error code). Logs are for operators; the business
 * audit trail stays in the database (audit_events) and is never replaced by logs.
 *
 * Never logged: credentials, passwords, session tokens, CSRF tokens, authorization headers,
 * cookies, API keys, DATABASE_URL, request or response bodies, uploaded documents, OCR text, bank
 * details, PAN, GSTIN or ERP payloads. Redaction below is a second line of
 * defence; the first is that nothing logs those values at all.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.secret',
  '*.secretAccessKey',
  '*.accessKeyId',
  '*.apiKey',
  '*.token',
  '*.authorization',
  'req.headers["x-veyra-csrf"]',
  'res.headers["set-cookie"]',
];

/**
 * Keys whose values are never logged (Phase 6C), matched case-insensitively anywhere in a log
 * object: credentials and session material, the database URL, and invoice data that identifies
 * people or money (bank details, PAN, GSTIN, OCR/document text).
 */
const SENSITIVE_KEY =
  /pass(word)?|secret|token|csrf|cookie|authori[sz]ation|api[-_]?key|credential|session|database_?url|connection_?string|dsn|pin$|^pan$|gstin|bank|ifsc|account_?(no|number)|iban|ocr_?(text|lines|words|output|result)|raw_?text|^text$|content|document_?bytes|body$/i;

/** Values that look like secrets even under an innocent key. */
const SENSITIVE_VALUE = [
  /postgres(ql)?:\/\/[^\s]+/gi,
  /\b[A-Z]{5}\d{4}[A-Z]\b/g, // PAN
  /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, // GSTIN
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

/**
 * The redaction helper: a copy of `value` with sensitive keys replaced by "[redacted]" and
 * secret-looking substrings masked. Used on every log line (createLogger) and available to any
 * code that must describe an object to operators.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') {
    let out = value;
    for (const re of SENSITIVE_VALUE) out = out.replace(re, '[redacted]');
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object' && !(value instanceof Error)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

/**
 * Errors in logs (Phase 6C): the type, a stable code and the stack frames, never the message of a
 * database error (Drizzle/pg messages carry the SQL, its parameters and row values, i.e. invoice
 * data) and never `detail`/`cause` values. Other messages are redacted and shortened.
 */
export function safeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { type: typeof err };
  const e = err as Error & { code?: unknown; cause?: unknown };
  const cause = e.cause as { code?: unknown; name?: unknown } | undefined;
  const database =
    e.name === 'DrizzleQueryError' ||
    e.name === 'DatabaseError' ||
    /^Failed query/.test(e.message) ||
    (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code));
  const code =
    typeof e.code === 'string' ? e.code : typeof cause?.code === 'string' ? cause.code : undefined;
  return {
    type: e.name,
    ...(code ? { code } : {}),
    message: database
      ? '[database error: message withheld]'
      : (redact(e.message.slice(0, 300)) as string),
    // Frames only: the stack's first lines repeat the message.
    stack: (e.stack ?? '')
      .split('\n')
      .filter((l) => /^\s+at /.test(l))
      .slice(0, 12)
      .join('\n'),
  };
}

export function createLogger(
  options: { level: string; environment: Environment },
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level: options.level,
      base: { service: 'veyra-api', env: options.environment },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      serializers: { err: safeError, error: safeError },
      formatters: {
        level: (label) => ({ level: label }),
        log: (object) => redact(object) as Record<string, unknown>,
      },
    },
    destination,
  );
}
