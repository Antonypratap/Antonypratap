import { SAMPLE_BASE_URL } from './sample/api';
import { ProfileSchema, type EntityConfig, type Profile } from './profile';

/**
 * Ready-made connection profiles ("presets"): the paths, paging and field mapping for a known ERP,
 * so the admin only adds the address and credentials. A preset is only a starting point the admin
 * reviews on the mapping screen. Presets are added from an ERP's real API documentation only.
 * (iBEAM by Innosolv: to be added when its API documentation is available; see docs/ERP-API.md.)
 */

const cursor = (
  path: string,
): Pick<EntityConfig, 'path' | 'query' | 'listPath' | 'paging' | 'incremental'> => ({
  path,
  query: {},
  listPath: 'data',
  paging: {
    style: 'cursor',
    cursorParam: 'cursor',
    nextCursorPath: 'next_cursor',
    sizeParam: 'limit',
    size: 50,
  },
  incremental: { param: 'updated_since', format: 'iso' },
});

/** The built-in Sample ERP (Example Co. ERP). */
export const SAMPLE_PRESET: Profile = ProfileSchema.parse({
  version: 1,
  name: 'Example Co. ERP (sample)',
  baseUrl: SAMPLE_BASE_URL,
  auth: { type: 'api_key', headerName: 'X-Api-Key' },
  scope: { query: {} },
  entities: {
    vendors: {
      ...cursor('/api/v2/vendors'),
      fields: {
        id: { path: 'vendor_code' },
        code: { path: 'vendor_code' },
        name: { path: 'vendor_name' },
        gstin: { path: 'gst_no' },
        address: { path: 'address' },
        status: { path: 'status' },
        updatedAt: { path: 'updated_at' },
      },
    },
    items: {
      ...cursor('/api/v2/items'),
      fields: {
        id: { path: 'item_code' },
        code: { path: 'item_code' },
        name: { path: 'item_name' },
        hsnSac: { path: 'hsn' },
        uom: { path: 'uom' },
        gstRateBp: { path: 'gst_rate' },
        updatedAt: { path: 'updated_at' },
      },
    },
    purchase_orders: {
      ...cursor('/api/v2/purchase-orders'),
      linesPath: 'items',
      fields: {
        id: { path: 'po_id' },
        poNumber: { path: 'po_no' },
        vendorRef: { path: 'vendor_code' },
        poDate: { path: 'po_date' },
        status: { path: 'status' },
        updatedAt: { path: 'updated_at' },
      },
      lineFields: {
        lineRef: { path: 'line_id' },
        itemRef: { path: 'item_code' },
        qtyMilli: { path: 'qty' },
        unitPricePaise: { path: 'rate' },
        gstRateBp: { path: 'gst_rate' },
      },
    },
    grns: {
      ...cursor('/api/v2/goods-receipts'),
      linesPath: 'items',
      fields: {
        id: { path: 'grn_id' },
        grnNumber: { path: 'grn_no' },
        poRef: { path: 'po_no' },
        grnDate: { path: 'grn_date' },
        updatedAt: { path: 'updated_at' },
      },
      lineFields: {
        poLineRef: { path: 'po_line_id' },
        itemRef: { path: 'item_code' },
        receivedQtyMilli: { path: 'qty_recd' },
        acceptedQtyMilli: { path: 'qty_accepted' },
      },
    },
    bills: {
      ...cursor('/api/v2/purchase-bills'),
      fields: {
        id: { path: 'bill_id' },
        billNumber: { path: 'bill_no' },
        vendorRef: { path: 'vendor_code' },
        billDate: { path: 'bill_date' },
        totalPaise: { path: 'bill_amount' },
        poRef: { path: 'po_no' },
        paymentStatus: { path: 'payment_status' },
        updatedAt: { path: 'updated_at' },
      },
    },
  },
});

export const PRESETS: { id: string; name: string; profile: Profile; sampleOnly: boolean }[] = [
  {
    id: 'sample',
    name: 'Example Co. ERP (the built-in Sample ERP)',
    profile: SAMPLE_PRESET,
    sampleOnly: true,
  },
];
