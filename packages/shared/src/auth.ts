/**
 * Roles and permissions (Phase 6C, docs/SECURITY.md). Deliberately small: a flat list of
 * permissions, one table. The server enforces them on every route; the web app only uses them to
 * hide what a role cannot do.
 *
 * Two kinds of role (Phase 8A):
 * - customer roles (ADMIN, FINANCE, REVIEWER): the customer's users, in the customer's
 *   organization, working with invoices. A customer ADMIN manages the customer's users.
 * - VEYRA_ADMIN: the Veyra team, in Veyra's own platform organization. It operates the deployment
 *   (Veyra Operations: plans, entitlements, usage, health) and has no customer permission at all:
 *   it cannot see invoices or documents. A customer ADMIN never gets it.
 */
export const CUSTOMER_ROLES = ['ADMIN', 'FINANCE', 'REVIEWER'] as const;
export type CustomerRole = (typeof CUSTOMER_ROLES)[number];
export const PLATFORM_ROLES = ['VEYRA_ADMIN'] as const;
export const ROLES = [...CUSTOMER_ROLES, ...PLATFORM_ROLES] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  /** See invoices, their questions and evidence. */
  'invoices.view',
  /** Upload invoice documents. */
  'documents.upload',
  /** Open the original uploaded document. */
  'documents.view',
  /** Answer questions (options that reject an invoice also need invoices.reject). */
  'questions.answer',
  'invoices.reject',
  'invoices.reprocess',
  /** Browse ERP records and the ERP connection. */
  'erp.view',
  /** The audit trail of one invoice. */
  'audit.invoice',
  /** The whole audit trail and business-record events. */
  'audit.view',
  /** Import business records into the ERP (an ERP write) and download templates. */
  'imports.manage',
  /** Download exports of invoices, decisions and the audit trail. */
  'exports.download',
  /** Create, disable and reset users. */
  'users.manage',
  /** Sign-ins, sign-outs, user changes, denied access, document access. */
  'security.audit',
  /** Demo tooling (reset, scenarios); only exists outside production. */
  'demo.manage',
  /** Veyra Operations (VEYRA_ADMIN only): read plans, entitlements, usage and platform health. */
  'ops.view',
  /** Veyra Operations (VEYRA_ADMIN only): assign plans, set and remove entitlement overrides. */
  'ops.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** The control-plane permissions: only platform roles have them. */
export const OPS_PERMISSIONS = ['ops.view', 'ops.manage'] as const satisfies readonly Permission[];
export const isOpsPermission = (p: string): boolean =>
  (OPS_PERMISSIONS as readonly string[]).includes(p);

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  ADMIN: PERMISSIONS.filter((p) => !isOpsPermission(p)),
  FINANCE: [
    'invoices.view',
    'documents.upload',
    'documents.view',
    'questions.answer',
    'invoices.reject',
    'invoices.reprocess',
    'erp.view',
    'audit.invoice',
    'audit.view',
    'imports.manage',
    'exports.download',
    'demo.manage',
  ],
  REVIEWER: ['invoices.view', 'documents.view', 'questions.answer', 'audit.invoice'],
  VEYRA_ADMIN: OPS_PERMISSIONS,
};

export function can(role: string, permission: Permission): boolean {
  return (
    (ROLE_PERMISSIONS as Record<string, readonly Permission[] | undefined>)[role]?.includes(
      permission,
    ) ?? false
  );
}

/**
 * Security audit events (Phase 6C), kept apart from the invoice workflow's audit trail
 * (`AUDIT_EVENTS`), whose VEYRA/YOU semantics are unchanged. Invoice rejection, reprocessing,
 * answers and ERP writes stay in the workflow trail, where they already are.
 */
export const SECURITY_EVENTS = [
  'login.succeeded',
  'login.failed',
  'logout',
  'user.created',
  'user.updated',
  'user.disabled',
  'user.enabled',
  'password.changed',
  'password.reset',
  'access.denied',
  'document.accessed',
] as const;
export type SecurityEvent = (typeof SECURITY_EVENTS)[number];
