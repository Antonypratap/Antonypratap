import type { Company, ErpConnector } from '@veyra/erp-connector';
import type { SampleDataset } from './api';

/**
 * The Sample ERP's records: the demo's own made-up manufacturing business (the fake ERP's demo
 * seed, docs/DEMO.md), re-shaped the way another ERP would expose them (its own field names,
 * Indian date style, rates in rupees, GST as a percent, lines nested in each record). So the demo
 * invoices match or differ against it exactly as they do in the demo.
 *
 * One addition, so a duplicate can be shown: the ERP already holds a purchase bill for the
 * two-page sample invoice (SSS/26-27/0520), as if someone had booked it by hand before it
 * reached Veyrafy.
 */

const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const rupees = (paise: number) => (paise / 100).toFixed(2);
const qty = (milli: number) => milli / 1000;
const percent = (bp: number) => bp / 100;

export interface SampleErp {
  dataset: SampleDataset;
  company: Company;
}

let cached: Promise<SampleErp> | null = null;

/** The demo seed's records, opened fresh (app.ts wires the built-in records; never stored). */
export type OpenDemoSeed = () => { connector: ErpConnector; close: () => void };

/** Built once per process from the demo seed (nothing is stored). */
export function sampleErp(openDemoSeed: OpenDemoSeed): Promise<SampleErp> {
  cached ??= (async () => {
    const { connector: erp, close } = openDemoSeed();
    try {
      const [company, vendors, items, pos, grns] = await Promise.all([
        erp.getCompany(),
        erp.listVendors(),
        erp.listItems(),
        erp.listPurchaseOrders(),
        erp.listGrns(),
      ]);
      const vendorCode = new Map(vendors.map((v) => [v.id as string, v.code]));
      const itemCode = new Map(items.map((i) => [i.id as string, i.code]));
      const poOf = new Map(pos.map((p) => [p.id as string, p]));
      const updated = '2026-09-01T04:30:00.000Z';
      const shakti = vendors.find((v) => v.gstin === '29AAFCS5678K1ZK');
      const dataset: SampleDataset = {
        vendors: vendors.map((v) => ({
          vendor_code: v.code,
          vendor_name: v.name,
          gst_no: v.gstin,
          address: v.address,
          status: v.status === 'active' ? 'Active' : 'Blocked',
          updated_at: updated,
        })),
        items: items.map((i) => ({
          item_code: i.code,
          item_name: i.name,
          hsn: i.hsnSac,
          uom: i.uom,
          gst_rate: percent(i.gstRateBp),
          updated_at: updated,
        })),
        purchaseOrders: pos.map((p) => ({
          po_id: `ORD-${p.poNumber}`,
          po_no: p.poNumber,
          vendor_code: vendorCode.get(p.vendorId) ?? '',
          po_date: dmy(p.poDate),
          status: p.status === 'open' ? 'Open' : 'Closed',
          updated_at: updated,
          items: p.lines.map((l) => ({
            line_id: `${p.poNumber}/${String(l.lineNo)}`,
            item_code: itemCode.get(l.itemId) ?? '',
            qty: qty(l.qtyMilli),
            rate: rupees(l.unitPricePaise),
            gst_rate: percent(l.gstRateBp),
          })),
        })),
        goodsReceipts: grns.map((g) => {
          const po = poOf.get(g.poId);
          return {
            grn_id: `RCV-${g.grnNumber}`,
            grn_no: g.grnNumber,
            po_no: po?.poNumber ?? '',
            grn_date: dmy(g.grnDate),
            updated_at: updated,
            items: g.lines.map((l) => {
              const pl = po?.lines.find((x) => x.id === l.poLineId);
              return {
                po_line_id: po && pl ? `${po.poNumber}/${String(pl.lineNo)}` : '',
                qty_recd: qty(l.receivedQtyMilli),
                qty_accepted: qty(l.acceptedQtyMilli),
              };
            }),
          };
        }),
        purchaseBills: shakti
          ? [
              {
                bill_id: 'PB-000417',
                bill_no: 'SSS/26-27/0520',
                vendor_code: shakti.code,
                bill_date: '27-09-2026',
                bill_amount: '113870.00',
                po_no: 'PO-2026-0101',
                payment_status: 'Unpaid',
                updated_at: updated,
              },
            ]
          : [],
      };
      return { dataset, company };
    } finally {
      close();
    }
  })();
  return cached;
}

/** Sample invoices to try against the Sample ERP: the demo's own made-up documents. */
export const SAMPLE_INVOICES = [
  { key: 'match', title: 'Matches the order and receipt', file: 'D01-clean-text.pdf' },
  { key: 'quantity', title: 'Bills more than received', file: 'D07-quantity-mismatch.pdf' },
  { key: 'rate', title: 'Price differs from the order', file: 'D08-rate-mismatch.pdf' },
  { key: 'no-receipt', title: 'Goods receipt not recorded', file: 'D12-missing-receipt.pdf' },
  { key: 'duplicate', title: 'Already booked in the ERP', file: 'D10-multi-page.pdf' },
] as const;
