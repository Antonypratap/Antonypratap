import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeErpConnector } from './connector';

const DRIZZLE = fileURLToPath(new URL('../drizzle', import.meta.url));
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('migrations', () => {
  it('upgrade a database with data from the first schema, keeping every record', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fake-erp-upgrade-'));
    // A migrations folder that stops at 0000, as an older version of Veyra shipped it.
    const old = join(dir, 'drizzle-0000');
    cpSync(DRIZZLE, old, { recursive: true });
    const journalPath = join(old, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] };
    writeFileSync(
      journalPath,
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }),
    );

    const file = join(dir, 'fake_erp.db');
    const sqlite = new Database(file);
    migrate(drizzle(sqlite), { migrationsFolder: old });
    const TS = '2026-09-01T00:00:00.000Z';
    sqlite.exec(`
      INSERT INTO company VALUES ('company','Veyra Demo Industries Pvt Ltd','29AAACS1111A1Z6','29');
      INSERT INTO vendors VALUES ('V001','V001','Shakti Steel Suppliers Pvt Ltd','shakti steel suppliers','29AAFCS5678K1ZK','AAFCS5678K','29','Karnataka','active','seed',NULL,'${TS}');
      INSERT INTO items VALUES ('ITM-001','ITM-001','MS Steel Rod 12mm','ms steel rod 12mm','7214','KGS',1800,'seed',NULL,'${TS}');
      INSERT INTO purchase_orders VALUES ('PO-1','PO-1','V001','2026-09-01','open','seed',NULL,NULL,'${TS}');
      INSERT INTO po_lines VALUES ('PO-1#1','PO-1',1,'ITM-001',100000,6250,1800);
      INSERT INTO grns VALUES ('GRN-1','GRN-1','PO-1','2026-09-01','seed',NULL,NULL,'${TS}');
      INSERT INTO grn_lines VALUES ('GRN-1#1','GRN-1','PO-1#1',100000,100000);
    `);
    sqlite.close();

    const erp = FakeErpConnector.open({ filename: file });
    try {
      expect(await erp.listVendors()).toEqual([
        expect.objectContaining({ code: 'V001', origin: 'seed', sourceImportId: null }),
      ]);
      expect(await erp.getPurchaseOrderByNumber('PO-1')).toMatchObject({
        lines: [{ id: 'PO-1#1' }],
      });
      expect((await erp.listGrns())[0]).toMatchObject({
        grnNumber: 'GRN-1',
        lines: [{ acceptedQtyMilli: 100000 }],
      });
    } finally {
      erp.close();
    }
  });
});
