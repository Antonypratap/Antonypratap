import { z } from 'zod';
import { PERMISSIONS, ROLES, SECURITY_EVENTS } from '../auth';

/** Wire contract for sign-in, the current session and user administration (Phase 6C). */
export const ApiUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  active: z.boolean(),
  /** Whether a password is set (never the hash). */
  canSignIn: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ApiUser = z.infer<typeof ApiUserSchema>;

export const ApiSessionSchema = z.discriminatedUnion('authenticated', [
  z.object({
    authenticated: z.literal(false),
    /** The demo PIN sign-in exists (demo environments only, never production). */
    demoSignIn: z.boolean(),
  }),
  z.object({
    authenticated: z.literal(true),
    demoSignIn: z.boolean(),
    user: z.object({ id: z.string(), name: z.string(), email: z.string(), role: z.enum(ROLES) }),
    permissions: z.array(z.enum(PERMISSIONS)),
    organization: z.object({ id: z.string(), name: z.string() }),
    /** Echo in the `x-veyra-csrf` header on every state-changing request. Keep in memory only. */
    csrfToken: z.string(),
    expiresAt: z.string(),
  }),
]);
export type ApiSession = z.infer<typeof ApiSessionSchema>;

/**
 * `GET /api/v1/instance`: which Veyrafy instance answers at this address. Public, and exactly these
 * two fields (strict): the organization's display name and whether it is the demo. The web app
 * uses it to confirm that a client address is set up; it carries nothing else, ever.
 */
export const ApiInstanceSchema = z.strictObject({
  name: z.string().min(1).max(120),
  demo: z.boolean(),
});
export type ApiInstance = z.infer<typeof ApiInstanceSchema>;

export const ApiLoginBodySchema = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(1024),
});

export const ApiSecurityEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  event: z.enum(SECURITY_EVENTS),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  subjectUserId: z.string().nullable(),
  requestId: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
});
export type ApiSecurityEvent = z.infer<typeof ApiSecurityEventSchema>;

/** The header a state-changing request carries its session's CSRF token in. */
export const CSRF_HEADER = 'x-veyra-csrf';
