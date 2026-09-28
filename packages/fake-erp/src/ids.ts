/**
 * Fake-ERP record identifiers. ERP ids are opaque to Veyra; the fake ERP makes them readable
 * and deterministic: masters use their code, documents their number, lines `<parent>#<n>`.
 */
export const vendorId = (code: string): string => code;
export const itemId = (code: string): string => code;
export const poId = (poNumber: string): string => poNumber;
export const poLineId = (po: string, lineNo: number): string => `${po}#${lineNo}`;
export const grnId = (grnNumber: string): string => grnNumber;
export const grnLineId = (grn: string, lineNo: number): string => `${grn}#${lineNo}`;
export const purchaseInvoiceId = (number: string): string => number;
export const purchaseInvoiceLineId = (invoice: string, lineNo: number): string =>
  `${invoice}#${lineNo}`;

export const pad = (n: number, width: number): string => String(n).padStart(width, '0');
