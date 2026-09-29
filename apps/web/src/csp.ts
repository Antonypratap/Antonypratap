import { z } from 'zod';

/**
 * The web CSP forbids eval (src/security-headers.ts). Zod's object parser otherwise probes for
 * `new Function` (a blocked eval, reported as a CSP violation) before falling back; jitless mode
 * skips the probe. Imported first by main.tsx, before any schema is used.
 */
z.config({ jitless: true });
