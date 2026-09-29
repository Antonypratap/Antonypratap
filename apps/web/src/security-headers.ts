/**
 * Security headers for the web app's static files (Phase 6C, docs/SECURITY.md and DEPLOYMENT.md).
 * Whatever serves `dist/` in production (the reverse proxy) must send exactly these; `vite
 * preview` sends them too, so the production build is tested under the same policy.
 *
 * The app is scripts and styles from its own origin only: no inline script, no eval, no third-
 * party origins, and it talks only to /api/v1 on the same origin.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const WEB_SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
