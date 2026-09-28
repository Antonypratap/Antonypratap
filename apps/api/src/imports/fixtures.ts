import { FakeErpConnector } from '@veyra/fake-erp';
import { writeCsv } from '../spreadsheet/csv';
import { writeXlsx } from '../spreadsheet/xlsx';
import { dataSheet, templateFiles, templateWorkbook } from './templates';
import { erpRows, erpSnapshot } from './validate';

/**
 * Demo import files (fixtures/imports). The records are the DEMO.md seed read back through
 * ErpConnector and written in template format, so they are exactly the records the demo invoices
 * expect. Used by `npm run fixtures:generate` and by tests.
 */
export async function importFixtures(): Promise<[string, Buffer][]> {
  const erp = FakeErpConnector.open({ filename: ':memory:', reset: 'demo' });
  try {
    const snapshot = await erpSnapshot(erp);
    const rows = erpRows(snapshot);
    const out: [string, Buffer][] = templateFiles().map((t) => [
      `templates/${t.file}`,
      templateWorkbook(t.file) as Buffer,
    ]);
    out.push(
      [
        'Demo-Business-Records.xlsx',
        writeXlsx([
          dataSheet('vendors', rows.vendors),
          dataSheet('items', rows.items),
          dataSheet('purchaseOrders', rows.purchaseOrders),
          dataSheet('purchaseOrderLines', rows.purchaseOrderLines),
          dataSheet('grns', rows.grns),
          dataSheet('grnLines', rows.grnLines),
        ]),
      ],
      ['Demo-1-Vendors.xlsx', writeXlsx([dataSheet('vendors', rows.vendors)])],
      ['Demo-2-Items.xlsx', writeXlsx([dataSheet('items', rows.items)])],
      [
        'Demo-3-PurchaseOrders.xlsx',
        writeXlsx([
          dataSheet('purchaseOrders', rows.purchaseOrders),
          dataSheet('purchaseOrderLines', rows.purchaseOrderLines),
        ]),
      ],
      [
        'Demo-4-GoodsReceipts.xlsx',
        writeXlsx([dataSheet('grns', rows.grns), dataSheet('grnLines', rows.grnLines)]),
      ],
      [
        'Demo-Vendors.csv',
        writeCsv([
          ['vendor_code', 'name', 'gstin', 'pan', 'address', 'state', 'active'],
          ...rows.vendors.map((r) => r.map((c) => (typeof c === 'object' ? c.money : c))),
        ]),
      ],
      [
        'Demo-Items-With-Errors.xlsx',
        writeXlsx([
          dataSheet('items', [
            ['ITM-101', 'Hex Bolt M10 x 50', '7318', 'NOS', '18'],
            ['', 'Washer M10', '7318', 'NOS', '18'],
            ['ITM-103', 'Spring Washer', '73', 'NOS', '18'],
            ['ITM-104', 'Anchor Fastener', '7318', 'BUNDLE', '18'],
            ['ITM-101', 'Hex Bolt M10 x 50 (again)', '7318', 'NOS', '18'],
          ]),
        ]),
      ],
    );
    return out;
  } finally {
    erp.close();
  }
}
