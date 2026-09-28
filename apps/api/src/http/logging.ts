import { pino, type DestinationStream, type Logger } from 'pino';
import type { Environment } from '../config';

/**
 * Structured JSON logs (Phase 6). One line per request (id, method, route, status, duration) and
 * one per job outcome (job id, invoice id, safe error code). Logs are for operators; the business
 * audit trail stays in the database (audit_events) and is never replaced by logs.
 *
 * Never logged: credentials, authorization headers, cookies, API keys, tokens, request or response
 * bodies, uploaded documents, OCR text or ERP payloads. Redaction below is a second line of
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
];

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
      formatters: { level: (label) => ({ level: label }) },
    },
    destination,
  );
}
