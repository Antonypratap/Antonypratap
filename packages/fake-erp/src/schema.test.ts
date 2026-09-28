import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempErp } from './test/temp-db';

/**
 * Database-level integrity of fake_erp.db, independent of the connector's own checks.
 * (Tests inside this package may use SQL; nothing outside it can.)
 */
let t: ReturnType<typeof tempErp>;
let db: Database.Database;
beforeAll(() => {
  t = tempErp({ reset: 'demo' });
  db = new Database(t.filename);
  db.pragma('foreign_keys = ON');
});
afterAll(() => {
  db.close();
  t.cleanup();
});

const TS = '2026-09-28T00:00:00.000Z';
const fails = (sql: string, code: string) => {
  let thrown: unknown;
  try {
    db.exec(`SAVEPOINT s; ${sql}; RELEASE s;`);
  } catch (e) {
    thrown = e;
    db.exec('ROLLBACK TO s; RELEASE s;');
  }
  expect((thrown as { code?: string } | undefined)?.code, sql).toBe(code);
};

describe('seed integrity', () => {
  it('has no foreign-key violations', () => {
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('stores every money, quantity and rate value as an INTEGER', () => {
    const cols: [string, string][] = [
      ['po_lines', 'qty_milli'],
      ['po_lines', 'unit_price_paise'],
      ['po_lines', 'gst_rate_bp'],
      ['items', 'gst_rate_bp'],
      ['grn_lines', 'received_qty_milli'],
      ['grn_lines', 'accepted_qty_milli'],
    ];
    for (const [table, col] of cols) {
      const types = db.prepare(`SELECT DISTINCT typeof(${col}) AS t FROM ${table}`).all();
      expect(types, `${table}.${col}`).toEqual([{ t: 'integer' }]);
    }
  });

  it('declares INTEGER affinity for every money, quantity and rate column', () => {
    const tables = [
      'items',
      'po_lines',
      'grn_lines',
      'purchase_invoices',
      'purchase_invoice_lines',
    ];
    for (const table of tables) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        type: string;
      }[];
      for (const c of cols.filter((x) => /_(paise|milli|bp)$/.test(x.name))) {
        expect(c.type.toUpperCase(), `${table}.${c.name}`).toBe('INTEGER');
      }
    }
  });
});

describe('constraints', () => {
  it('foreign keys are enforced', () => {
    fails(
      `INSERT INTO po_lines VALUES ('X#1', 'NO-SUCH-PO', 1, 'ITM-001', 1000, 100, 1800)`,
      'SQLITE_CONSTRAINT_FOREIGNKEY',
    );
    fails(
      `INSERT INTO grn_lines VALUES ('G#9', 'GRN-2026-0201', 'NO-SUCH-LINE', 1000, 1000)`,
      'SQLITE_CONSTRAINT_FOREIGNKEY',
    );
  });

  it('natural keys are unique', () => {
    fails(
      `INSERT INTO vendors VALUES ('V999','V999','Dup','dup','29AAFCS5678K1ZK','AAFCS5678K','29','x','active','seed',NULL,NULL,'${TS}')`,
      'SQLITE_CONSTRAINT_UNIQUE',
    );
    fails(
      `INSERT INTO purchase_orders VALUES ('P2','PO-2026-0101','V001','2026-09-01','open','seed',NULL,NULL,NULL,'${TS}')`,
      'SQLITE_CONSTRAINT_UNIQUE',
    );
    fails(
      `INSERT INTO po_lines VALUES ('PO-2026-0101#9', 'PO-2026-0101', 1, 'ITM-001', 1000, 100, 1800)`,
      'SQLITE_CONSTRAINT_UNIQUE',
    );
  });

  it('refuses floating-point money, quantities and rates', () => {
    fails(
      `INSERT INTO po_lines VALUES ('PO-2026-0104#2', 'PO-2026-0104', 2, 'ITM-003', 1000, 62.5, 1800)`,
      'SQLITE_CONSTRAINT_CHECK',
    );
    fails(
      `INSERT INTO po_lines VALUES ('PO-2026-0104#2', 'PO-2026-0104', 2, 'ITM-003', 1000.5, 100, 1800)`,
      'SQLITE_CONSTRAINT_CHECK',
    );
    fails(
      `INSERT INTO po_lines VALUES ('PO-2026-0104#2', 'PO-2026-0104', 2, 'ITM-003', 1000, 100, 18.5)`,
      'SQLITE_CONSTRAINT_CHECK',
    );
    fails(`UPDATE items SET gst_rate_bp = 10001 WHERE id = 'ITM-001'`, 'SQLITE_CONSTRAINT_CHECK');
  });

  it('enforces GST identity, dates and origins', () => {
    fails(`UPDATE vendors SET pan = 'AAAAA0000A' WHERE id = 'V001'`, 'SQLITE_CONSTRAINT_CHECK');
    fails(`UPDATE vendors SET state_code = '27' WHERE id = 'V001'`, 'SQLITE_CONSTRAINT_CHECK');
    fails(
      `UPDATE purchase_orders SET po_date = '2026-02-30' WHERE id = 'PO-2026-0101'`,
      'SQLITE_CONSTRAINT_CHECK',
    );
    fails(
      `UPDATE purchase_orders SET origin = 'auto_created_from_invoice' WHERE id = 'PO-2026-0101'`,
      'SQLITE_CONSTRAINT_CHECK',
    );
    fails(
      `UPDATE grns SET origin = 'user_confirmed_via_veyra' WHERE id = 'GRN-2026-0201'`,
      'SQLITE_CONSTRAINT_CHECK',
    );
    fails(`UPDATE items SET hsn_sac = '72A4' WHERE id = 'ITM-001'`, 'SQLITE_CONSTRAINT_CHECK');
    fails(
      `INSERT INTO company VALUES ('company2', 'X', '27AAACA4321M1ZT', '27')`,
      'SQLITE_CONSTRAINT_CHECK',
    );
  });

  it('GRN accepted quantity cannot exceed received', () => {
    fails(
      `UPDATE grn_lines SET accepted_qty_milli = received_qty_milli + 1 WHERE id = 'GRN-2026-0201#1'`,
      'SQLITE_CONSTRAINT_CHECK',
    );
  });

  it('purchase invoices: total must add up, and there is no status but verified_pending_payment', () => {
    const insert = (total: number, status: string) =>
      `INSERT INTO purchase_invoices VALUES ('PI', 'V001', 'X-1', 'X-1', '2026-09-15', '2026-27', 'PO-2026-0101',
        100, 9, 9, 0, NULL, ${total}, '${status}', '${'1'.padStart(26, '0')}', 'veyra:${'1'.padStart(26, '0')}:purchase_invoice', '${TS}')`;
    fails(insert(119, 'verified_pending_payment'), 'SQLITE_CONSTRAINT_CHECK');
    fails(insert(118, 'paid'), 'SQLITE_CONSTRAINT_CHECK');
  });
});
