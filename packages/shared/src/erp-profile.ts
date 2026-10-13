import { z } from 'zod';

/**
 * A connection profile: everything Veyrafy needs to read one ERP's records over its REST/JSON API,
 * none of it secret. The secrets (API key, password, token, client secret) are stored separately,
 * encrypted (apps/api/src/erp-api/secrets.ts). A profile can be exported and reused for the next customer on the same
 * ERP (a preset). Nothing here is specific to any one ERP vendor.
 */

export const ENTITIES = ['vendors', 'items', 'purchase_orders', 'grns', 'bills'] as const;
export type Entity = (typeof ENTITIES)[number];

export const ENTITY_LABEL: Record<Entity, string> = {
  vendors: 'Suppliers',
  items: 'Items',
  purchase_orders: 'Purchase orders',
  grns: 'Goods receipts',
  bills: 'Purchase bills',
};

/** How a value read from the ERP becomes a Veyrafy value. */
export const CONVERSIONS = [
  'text',
  'rupees',
  'paise',
  'quantity',
  'milli',
  'percent',
  'basis_points',
  'date',
  'status',
] as const;
export type Conversion = (typeof CONVERSIONS)[number];

export const CONVERSION_LABEL: Record<Conversion, string> = {
  text: 'Text',
  rupees: 'Amount in rupees',
  paise: 'Amount in paise',
  quantity: 'Quantity',
  milli: 'Quantity in thousandths',
  percent: 'Percent (18 = 18%)',
  basis_points: 'Basis points (1800 = 18%)',
  date: 'Date',
  status: 'Active / closed word',
};

export interface FieldSpec {
  key: string;
  label: string;
  convert: Conversion;
  /** Needed for a record to be kept at all. */
  required: boolean;
  /** Alternatives: at least one field of a group is needed. */
  oneOf?: string;
  /** Names an ERP often uses for this field (helps propose a mapping). */
  hints: readonly string[];
}

const f = (
  key: string,
  label: string,
  convert: Conversion,
  hints: string[],
  opts: { required?: boolean; oneOf?: string } = {},
): FieldSpec => ({
  key,
  label,
  convert,
  required: opts.required ?? false,
  hints,
  ...(opts.oneOf ? { oneOf: opts.oneOf } : {}),
});

/** The fields of each record (header) and of its lines, in Veyrafy's terms. */
export const FIELDS: Record<Entity, { header: FieldSpec[]; line: FieldSpec[] }> = {
  vendors: {
    header: [
      f(
        'id',
        'ERP record ID',
        'text',
        ['id', 'vendor_id', 'supplier_id', 'ledger_id', 'party_id'],
        { required: true },
      ),
      f('code', 'Supplier code', 'text', ['code', 'vendor_code', 'supplier_code', 'party_code']),
      f(
        'name',
        'Supplier name',
        'text',
        ['name', 'vendor_name', 'supplier_name', 'party_name', 'legal_name'],
        { required: true },
      ),
      f('gstin', 'GSTIN', 'text', ['gstin', 'gst_no', 'gst_number', 'gstn', 'gst_in']),
      f('address', 'Address', 'text', ['address', 'addr', 'billing_address', 'address_line1']),
      f('status', 'Status', 'status', ['status', 'active', 'is_active', 'state']),
      f('updatedAt', 'Last changed', 'text', [
        'updated_at',
        'modified_at',
        'last_modified',
        'modified_on',
      ]),
    ],
    line: [],
  },
  items: {
    header: [
      f('id', 'ERP record ID', 'text', ['id', 'item_id', 'product_id', 'material_id'], {
        required: true,
      }),
      f('code', 'Item code', 'text', ['code', 'item_code', 'sku', 'product_code', 'material_code']),
      f('name', 'Item name', 'text', ['name', 'item_name', 'description', 'product_name'], {
        required: true,
      }),
      f('hsnSac', 'HSN/SAC', 'text', ['hsn', 'hsn_code', 'hsn_sac', 'sac']),
      f('uom', 'Unit', 'text', ['uom', 'unit', 'units', 'unit_of_measure']),
      f('gstRateBp', 'GST rate', 'percent', ['gst_rate', 'tax_rate', 'gst', 'gst_percent']),
      f('updatedAt', 'Last changed', 'text', ['updated_at', 'modified_at', 'last_modified']),
    ],
    line: [],
  },
  purchase_orders: {
    header: [
      f('id', 'ERP record ID', 'text', ['id', 'po_id', 'order_id'], { required: true }),
      f('poNumber', 'PO number', 'text', ['po_no', 'po_number', 'order_no', 'number', 'doc_no'], {
        required: true,
      }),
      f(
        'vendorRef',
        'Supplier (ID or code)',
        'text',
        ['vendor_id', 'vendor_code', 'supplier_id', 'supplier_code', 'party_id'],
        { required: true },
      ),
      f('poDate', 'PO date', 'date', ['po_date', 'order_date', 'date', 'doc_date'], {
        required: true,
      }),
      f('status', 'Status', 'status', ['status', 'state', 'po_status']),
      f('updatedAt', 'Last changed', 'text', ['updated_at', 'modified_at', 'last_modified']),
    ],
    line: [
      f('lineRef', 'Line ID', 'text', ['id', 'line_id', 'po_line_id']),
      f('lineNo', 'Line number', 'text', ['line_no', 'line', 'sr_no', 'seq', 'line_number']),
      f('itemRef', 'Item (ID or code)', 'text', ['item_id', 'item_code', 'sku', 'product_id'], {
        required: true,
      }),
      f(
        'qtyMilli',
        'Quantity ordered',
        'quantity',
        ['qty', 'quantity', 'ordered_qty', 'qty_ordered'],
        { required: true },
      ),
      f('unitPricePaise', 'Rate', 'rupees', ['rate', 'price', 'unit_price', 'unit_rate'], {
        required: true,
      }),
      f('gstRateBp', 'GST rate', 'percent', ['gst_rate', 'tax_rate', 'gst', 'gst_percent']),
    ],
  },
  grns: {
    header: [
      f('id', 'ERP record ID', 'text', ['id', 'grn_id', 'receipt_id', 'mrn_id'], {
        required: true,
      }),
      f(
        'grnNumber',
        'GRN number',
        'text',
        ['grn_no', 'grn_number', 'receipt_no', 'mrn_no', 'number'],
        { required: true },
      ),
      f(
        'poRef',
        'Purchase order (ID or number)',
        'text',
        ['po_id', 'po_no', 'po_number', 'order_id'],
        { required: true },
      ),
      f('grnDate', 'GRN date', 'date', ['grn_date', 'receipt_date', 'date', 'doc_date'], {
        required: true,
      }),
      f('updatedAt', 'Last changed', 'text', ['updated_at', 'modified_at', 'last_modified']),
    ],
    line: [
      f('poLineRef', 'PO line ID', 'text', ['po_line_id', 'order_line_id'], { oneOf: 'line' }),
      f('itemRef', 'Item (ID or code)', 'text', ['item_id', 'item_code', 'sku'], { oneOf: 'line' }),
      f('receivedQtyMilli', 'Quantity received', 'quantity', [
        'qty_recd',
        'received_qty',
        'qty_received',
        'received',
      ]),
      f(
        'acceptedQtyMilli',
        'Quantity accepted',
        'quantity',
        ['qty_accepted', 'accepted_qty', 'accepted', 'qty_ok'],
        { required: true },
      ),
    ],
  },
  bills: {
    header: [
      f('id', 'ERP record ID', 'text', ['id', 'bill_id', 'invoice_id', 'voucher_id'], {
        required: true,
      }),
      f(
        'billNumber',
        'Supplier invoice number',
        'text',
        ['bill_no', 'invoice_no', 'supplier_invoice_no', 'vendor_invoice_no', 'ref_no'],
        { required: true },
      ),
      f(
        'vendorRef',
        'Supplier (ID or code)',
        'text',
        ['vendor_id', 'vendor_code', 'supplier_id', 'party_id'],
        { required: true },
      ),
      f('billDate', 'Invoice date', 'date', ['bill_date', 'invoice_date', 'date', 'ref_date'], {
        required: true,
      }),
      f('totalPaise', 'Invoice total', 'rupees', [
        'total',
        'amount',
        'bill_amount',
        'invoice_amount',
        'grand_total',
      ]),
      f('poRef', 'Purchase order (ID or number)', 'text', ['po_id', 'po_no', 'po_number']),
      f('paymentStatus', 'Payment status', 'text', ['payment_status', 'paid_status', 'status']),
      f('updatedAt', 'Last changed', 'text', ['updated_at', 'modified_at', 'last_modified']),
    ],
    line: [],
  },
};

const jsonPath = z
  .string()
  .max(200)
  .regex(
    /^[A-Za-z0-9_$@-]+(\.[A-Za-z0-9_$@-]+)*$/,
    'a dotted path such as data.items or vendor.code',
  );
const optionalPath = z.union([jsonPath, z.literal('')]).optional();
const paramName = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9_.[\]-]+$/);
const query = z.record(paramName, z.string().max(200)).default({});

export const FieldMappingSchema = z.object({
  path: jsonPath,
  convert: z.enum(CONVERSIONS).optional(),
});
export type FieldMapping = z.infer<typeof FieldMappingSchema>;

export const PagingSchema = z.discriminatedUnion('style', [
  z.object({ style: z.literal('none') }),
  z.object({
    style: z.literal('page'),
    pageParam: paramName,
    sizeParam: paramName,
    size: z.int().min(1).max(1000),
    firstPage: z.int().min(0).max(1).default(1),
  }),
  z.object({
    style: z.literal('offset'),
    offsetParam: paramName,
    limitParam: paramName,
    limit: z.int().min(1).max(1000),
  }),
  z.object({
    style: z.literal('cursor'),
    cursorParam: paramName,
    nextCursorPath: jsonPath,
    sizeParam: paramName.optional(),
    size: z.int().min(1).max(1000).optional(),
  }),
  z.object({ style: z.literal('link'), nextLinkPath: jsonPath }),
]);
export type Paging = z.infer<typeof PagingSchema>;

export const EntityConfigSchema = z.object({
  /** Path under the base URL, e.g. /api/v1/suppliers. */
  path: z
    .string()
    .min(1)
    .max(300)
    .regex(/^\/[^\s?#]*$/, 'a path starting with /'),
  query,
  /** Where the list of records is in the response; empty when the response is the list itself. */
  listPath: optionalPath,
  paging: PagingSchema,
  /** Only records changed since the last sync, when the ERP can filter that way. */
  incremental: z
    .object({ param: paramName, format: z.enum(['iso', 'date', 'epoch_seconds']) })
    .optional(),
  /** For purchase orders and goods receipts: where each record's lines are. */
  linesPath: optionalPath,
  fields: z.record(z.string(), FieldMappingSchema),
  lineFields: z.record(z.string(), FieldMappingSchema).default({}),
});
export type EntityConfig = z.infer<typeof EntityConfigSchema>;

export const AUTH_TYPES = [
  'none',
  'api_key',
  'basic',
  'bearer',
  'oauth2_client_credentials',
] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export const AuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('api_key'),
    headerName: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[A-Za-z0-9-]+$/),
  }),
  z.object({ type: z.literal('basic'), username: z.string().min(1).max(200) }),
  z.object({ type: z.literal('bearer') }),
  z.object({
    type: z.literal('oauth2_client_credentials'),
    tokenUrl: z.string().url().max(500),
    clientId: z.string().min(1).max(200),
    scope: z.string().max(500).optional(),
  }),
]);
export type Auth = z.infer<typeof AuthSchema>;

/** The secret each login method needs (stored encrypted, never returned). */
export const AUTH_SECRET: Record<AuthType, { key: string; label: string } | null> = {
  none: null,
  api_key: { key: 'apiKey', label: 'API key' },
  basic: { key: 'password', label: 'Password' },
  bearer: { key: 'token', label: 'Access token' },
  oauth2_client_credentials: { key: 'clientSecret', label: 'Client secret' },
};

export const ProfileSchema = z.object({
  version: z.literal(1),
  /** What the person calls this ERP ("Our ERP", "Example Co. ERP"). */
  name: z.string().min(1).max(80),
  /** https://… (or sample://example-erp for the built-in Sample ERP). */
  baseUrl: z.string().min(1).max(300),
  auth: AuthSchema,
  /** Company and outlet scope: fixed query parameters on every call, and a check on each record. */
  scope: z
    .object({
      query,
      companyPath: optionalPath,
      companyValue: z.string().max(100).optional(),
      outletPath: optionalPath,
      outletValue: z.string().max(100).optional(),
    })
    .default({ query: {} }),
  entities: z.partialRecord(z.enum(ENTITIES), EntityConfigSchema),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** What must be mapped before a record type can be synced (field keys missing). */
export function missingRequired(entity: Entity, config: EntityConfig): string[] {
  const spec = FIELDS[entity];
  const missing: string[] = [];
  for (const s of spec.header) if (s.required && !config.fields[s.key]?.path) missing.push(s.key);
  if (spec.line.length > 0) {
    if (!config.linesPath) missing.push('linesPath');
    for (const s of spec.line)
      if (s.required && !config.lineFields[s.key]?.path) missing.push(`line.${s.key}`);
    const groups = new Set(spec.line.flatMap((s) => (s.oneOf ? [s.oneOf] : [])));
    for (const g of groups)
      if (!spec.line.some((s) => s.oneOf === g && config.lineFields[s.key]?.path))
        missing.push(`line.${g}`);
  }
  return missing;
}

/**
 * The built-in Sample ERP (made-up records, for showing the whole story). Its key is not a secret:
 * it opens only made-up records, and it is shown on screen.
 */
export const SAMPLE_ERP = {
  baseUrl: 'sample://example-erp',
  apiKey: 'sample-erp-demo-key',
} as const;

export const AUTH_LABEL: Record<AuthType, string> = {
  none: 'No login',
  api_key: 'API key in a header',
  basic: 'Username and password',
  bearer: 'Access token',
  oauth2_client_credentials: 'OAuth 2 (client credentials)',
};
