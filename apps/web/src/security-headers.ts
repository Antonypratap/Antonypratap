/**
 * Security headers for the web app's static files (Phase 6C, docs/SECURITY.md and DEPLOYMENT.md).
 * Whatever serves `dist/` in production (the reverse proxy) must send exactly these; `vite
 * preview` sends them too, so the production build is tested under the same policy.
 *
 * The app is scripts and styles from its own origin only: no inline script, no eval, no third-
 * party origins, and it talks only to the Veyra API: /api/v1 on the same origin by default.
 */
/**
 * The CSP. `apiOrigin`: the API's origin when VITE_API_BASE_URL points at another origin
 * (api-base.ts); it is then the one addition to connect-src. Nothing else ever widens.
 */
export function contentSecurityPolicy(apiOrigin: string | null = null): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    apiOrigin ? `connect-src 'self' ${apiOrigin}` : "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export const CONTENT_SECURITY_POLICY = contentSecurityPolicy();

export const WEB_SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/** The headers for a build whose API is on `apiOrigin` (null: the same origin). */
export function webSecurityHeaders(apiOrigin: string | null = null): Record<string, string> {
  return { ...WEB_SECURITY_HEADERS, 'Content-Security-Policy': contentSecurityPolicy(apiOrigin) };
}
