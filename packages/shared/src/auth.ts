/**
 * Roles and permissions (Phase 6C, docs/SECURITY.md). Deliberately small: three roles, a flat list
 * of permissions, one table. The server enforces them on every route; the web app only uses them
 * to hide what a role cannot do.
 */
export const ROLES = ['ADMIN', 'FINANCE', 'REVIEWER'] as const;
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
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  ADMIN: PERMISSIONS,
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
