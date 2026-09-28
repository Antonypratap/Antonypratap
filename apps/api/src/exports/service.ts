import { paise, paiseToDecimalString } from '@veyra/shared';
import { STATUS_TEXT } from '../http/present';
import type { Presenter } from '../http/present';
import { dataSheet } from '../imports/templates';
import { erpRows, type ErpSnapshot } from '../imports/validate';
import { writeCsv } from '../spreadsheet/csv';
import { writeXlsx, type OutCell } from '../spreadsheet/xlsx';

/**
 * Lightweight exports (Phase 3C): business-useful columns, no internal ids unless useful.
 * XLSX by default; CSV for single tables. Amounts are exact (from integer paise).
 */

export interface Table {
  sheet: string;
  headers: string[];
  widths: number[];
  rows: OutCell[][];
}

/** "2026-09-28 12:00" in India time. */
export function istDateTime(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

const money = (p: number | null): OutCell =>
  p === null ? null : { money: paiseToDecimalString(paise(p)) };

export async function invoicesTable(present: Presenter): Promise<Table> {
  const inbox = await present.inbox();
  return {
    sheet: 'Invoices',
    headers: [
      'Invoice number',
      'Vendor',
      'Invoice date',
      'Amount (₹)',
      'Status',
      'Decision',
      'Decision date',
      'Ready for payment',
      'Note',
      'Received',
      'File',
    ],
    widths: [20, 34, 13, 14, 20, 34, 17, 12, 40, 17, 28],
    rows: inbox.invoices.map((i) => [
      i.number ?? '',
      i.supplierName ?? '',
      i.invoiceDate ?? '',
      money(i.totalPaise),
      STATUS_TEXT[i.status],
      i.decision?.label ?? '',
      i.decision ? istDateTime(i.decision.at) : '',
      i.state === 'VERIFIED_PENDING_PAYMENT' ? 'Yes' : 'No',
      i.note ?? i.failure?.reason ?? '',
      istDateTime(i.receivedAt),
      i.filename,
    ]),
  };
}

export async function decisionsTable(present: Presenter): Promise<Table> {
  const answered = await present.questions('answered');
  return {
    sheet: 'Decisions',
    headers: [
      'Decided at',
      'Invoice number',
      'Vendor',
      'Question',
      'Details',
      'Decision',
      'Result',
      'Decided by',
    ],
    widths: [17, 20, 34, 24, 44, 36, 44, 11],
    rows: answered.map((q) => [
      q.answeredAt ? istDateTime(q.answeredAt) : '',
      q.invoice.number ?? '',
      q.invoice.supplierName ?? '',
      q.summary,
      q.evidence,
      q.answer?.label ?? '',
      q.answer?.result ?? '',
      'You',
    ]),
  };
}

export async function auditTable(present: Presenter): Promise<Table> {
  const inbox = await present.inbox();
  const numbers = new Map(inbox.invoices.map((i) => [i.id, i.number ?? i.filename]));
  return {
    sheet: 'Audit trail',
    headers: ['Date/time', 'Invoice', 'Action', 'Actor', 'Description'],
    widths: [17, 22, 30, 8, 70],
    rows: present
      .audit(null)
      .map((e) => [
        istDateTime(e.at),
        e.invoiceId ? (numbers.get(e.invoiceId) ?? '') : 'Business records',
        e.title,
        e.by,
        e.detail,
      ]),
  };
}

export function tableXlsx(table: Table): Buffer {
  return writeXlsx([
    { name: table.sheet, widths: table.widths, header: true, rows: [table.headers, ...table.rows] },
  ]);
}

export function tableCsv(table: Table): Buffer {
  return writeCsv([
    table.headers,
    ...table.rows.map((r) =>
      r.map((c) =>
        c === null
          ? null
          : typeof c === 'string' || typeof c === 'number'
            ? c
            : 'money' in c
              ? c.money
              : c.text,
      ),
    ),
  ]);
}

/** All business records in the import template format: an export can be imported again. */
export function businessRecordsXlsx(snapshot: ErpSnapshot): Buffer {
  const rows = erpRows(snapshot);
  return writeXlsx([
    dataSheet('vendors', rows.vendors),
    dataSheet('items', rows.items),
    dataSheet('purchaseOrders', rows.purchaseOrders),
    dataSheet('purchaseOrderLines', rows.purchaseOrderLines),
    dataSheet('grns', rows.grns),
    dataSheet('grnLines', rows.grnLines),
  ]);
}
