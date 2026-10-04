/**
 * Commercial entitlements (Phase 8A, docs/COMMERCIAL_ENTITLEMENTS.md).
 *
 *   PLAN → PLAN ENTITLEMENTS → ORGANIZATION (+ OVERRIDES) → EFFECTIVE CAPABILITY → SERVER CHECK
 *
 * The catalogue below is the only list of commercially controlled capabilities. A key is stable:
 * it is stored in the database and the audit trail, so it is never renamed or reused. Only
 * capabilities the product really has are registered (a switch for a feature that does not exist
 * would promise something Veyra cannot do).
 *
 * What is NOT here, on purpose: validation, GST checks, duplicate detection, 3-way matching,
 * security and audit. Those are Veyra's safety rules; no plan or override can switch them off.
 *
 * Code asks for a capability by key (`invoice.monthly_limit`), never for a plan by name.
 */
export type CapabilityType = 'BOOLEAN' | 'LIMIT';
export type CapabilityCategory = 'invoices' | 'erp' | 'reports' | 'account';

export interface CapabilityDefinition {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly category: CapabilityCategory;
  /** BOOLEAN: on or off. LIMIT: a quota (a whole number; unlimited is allowed). */
  readonly type: CapabilityType;
  /** Shown to the customer's users (availability, and usage against a limit). */
  readonly customerVisible: boolean;
  /** LIMIT only: what is counted. */
  readonly unit?: 'invoices' | 'users' | 'bytes';
  /**
   * The ERP connector capability the feature also needs (packages/erp-connector). A commercial
   * entitlement never grants what the connected ERP cannot do, and the reverse.
   */
  readonly erpCapability?: string;
  /** Bumped only if the meaning ever changes (then a new key is usually better). */
  readonly version: 1;
}

export const CAPABILITIES = [
  {
    key: 'erp.business_record_import',
    name: 'Import business records',
    description:
      'Import suppliers, items, purchase orders and goods receipts from Excel or CSV into the ERP.',
    category: 'erp',
    type: 'BOOLEAN',
    customerVisible: true,
    erpCapability: 'business_records.import',
    version: 1,
  },
  {
    key: 'reports.exports',
    name: 'Exports',
    description: 'Download invoices, decisions, business records and the audit trail as Excel.',
    category: 'reports',
    type: 'BOOLEAN',
    customerVisible: true,
    version: 1,
  },
  {
    key: 'invoice.monthly_limit',
    name: 'Invoices per month',
    description: 'Invoice documents that can be uploaded in one calendar month (UTC).',
    category: 'invoices',
    type: 'LIMIT',
    unit: 'invoices',
    customerVisible: true,
    version: 1,
  },
  {
    key: 'users.max',
    name: 'Active users',
    description: 'User accounts that can be active at the same time.',
    category: 'account',
    type: 'LIMIT',
    unit: 'users',
    customerVisible: true,
    version: 1,
  },
  {
    key: 'storage.max_bytes',
    name: 'Document storage',
    description: 'Total size of the uploaded invoice documents.',
    category: 'account',
    type: 'LIMIT',
    unit: 'bytes',
    customerVisible: true,
    version: 1,
  },
] as const satisfies readonly CapabilityDefinition[];

export type CapabilityKey = (typeof CAPABILITIES)[number]['key'];
export const CAPABILITY_KEYS = CAPABILITIES.map((c) => c.key) as readonly CapabilityKey[];

export function capabilityDefinition(key: string): CapabilityDefinition | undefined {
  return (CAPABILITIES as readonly CapabilityDefinition[]).find((c) => c.key === key);
}

/**
 * A value: BOOLEAN → `enabled`; LIMIT → `limit` (null = unlimited). "No entitlement" is not a
 * value: it resolves to unavailable (off, or a limit of 0).
 */
export type EntitlementValue = { enabled: boolean } | { limit: number | null };

export const PLAN_STATUSES = ['active', 'retired'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
/**
 * A customer's standing: on trial, active, or suspended by Veyrafy Operations (its users are
 * refused; its data is kept and nothing is deleted). Suspension is a separate, audited action.
 */
export const COMMERCIAL_STATUSES = ['trial', 'active', 'suspended'] as const;
export type CommercialStatus = (typeof COMMERCIAL_STATUSES)[number];
/** What a plan assignment can set (suspension has its own action). */
export const ASSIGNABLE_STATUSES = ['trial', 'active'] as const;

/** Why an organization has (or lacks) a capability: the operator must be able to see it. */
export type EntitlementSource = 'override' | 'plan' | 'none';

/**
 * The platform audit trail (append-only): commercial changes, and every other administrative
 * action taken in the Control Centre.
 */
export const COMMERCIAL_EVENTS = [
  'plan.assigned',
  'plan.entitlement_changed',
  'override.set',
  'override.removed',
  'plan.price_changed',
  'organization.suspended',
  'organization.reactivated',
  'user.disabled',
  'user.enabled',
  'processing.retried',
  'config.changed',
  'challenge.follow_up_changed',
] as const;
export type CommercialEvent = (typeof COMMERCIAL_EVENTS)[number];

/** How a value reads to a person ("On", "2,000", "Unlimited", "20 GB"). */
export function formatEntitlement(
  def: Pick<CapabilityDefinition, 'type' | 'unit'>,
  value: EntitlementValue | null,
): string {
  if (value === null) return '—';
  if ('enabled' in value) return value.enabled ? 'On' : 'Off';
  if (value.limit === null) return 'Unlimited';
  if (def.unit === 'bytes') return formatBytes(value.limit);
  return value.limit.toLocaleString('en-IN');
}

export function formatBytes(bytes: number): string {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (bytes >= GB) return `${Math.round((bytes / GB) * 10) / 10} GB`;
  if (bytes >= MB) return `${Math.round((bytes / MB) * 10) / 10} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}
