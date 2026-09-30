import { and, eq, sql } from 'drizzle-orm';
import type { ApiUsage } from '@veyra/shared';
import { rowsOf, type VeyraDb } from '../db/open';
import * as t from '../db/schema';

/** The first instant of the calendar month (UTC) and of the next one. */
export function monthOf(now: Date): { from: string; to: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * What a deployment's organization has used (Phase 8A): counted from the product's own records,
 * not from a second accounting system. Five aggregate queries, run together, each bounded by an
 * index or by the month (no per-invoice queries).
 *
 * One organization per deployment (not multi-tenancy): the invoices and documents of this database
 * are that organization's.
 */
export async function usageOf(db: VeyraDb, organizationId: string, now: Date): Promise<ApiUsage> {
  const month = monthOf(now);
  const [docs, states, ocr, erp, users] = await Promise.all([
    db
      .select({
        month: sql<number>`count(*) filter (where ${t.documents.uploadedAt} >= ${month.from}::timestamptz)::int`,
        total: sql<number>`count(*)::int`,
        bytes: sql<string>`coalesce(sum(${t.documents.sizeBytes}), 0)::text`,
      })
      .from(t.documents),
    db
      .select({ state: t.invoices.state, n: sql<number>`count(*)::int` })
      .from(t.invoices)
      .groupBy(t.invoices.state),
    db.execute(sql`
      select count(distinct e.invoice_id)::int as n from extractions e
      where e.created_at >= ${month.from}::timestamptz
        and exists (select 1 from extracted_fields f where f.extraction_id = e.id and f.method = 'tesseract')`),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(t.erpWrites)
      .where(
        and(
          eq(t.erpWrites.status, 'confirmed'),
          sql`${t.erpWrites.updatedAt} >= ${month.from}::timestamptz`,
        ),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(t.users)
      .where(and(eq(t.users.organizationId, organizationId), eq(t.users.active, true))),
  ]);
  const by = Object.fromEntries(states.map((s) => [s.state, s.n])) as Record<string, number>;
  const n = (...keys: string[]) => keys.reduce((sum, k) => sum + (by[k] ?? 0), 0);
  return {
    month,
    invoicesThisMonth: docs[0]?.month ?? 0,
    invoicesTotal: docs[0]?.total ?? 0,
    invoicesByOutcome: {
      processing: n('UPLOADED', 'EXTRACTING', 'MATCHING', 'RESOLVING', 'VALIDATING', 'COMMITTING'),
      needsDecision: n('NEEDS_INPUT'),
      verified: n('VERIFIED_PENDING_PAYMENT'),
      rejected: n('REJECTED'),
      failed: n('FAILED'),
    },
    ocrThisMonth: rowsOf<{ n: number }>(ocr)[0]?.n ?? 0,
    erpWritesThisMonth: erp[0]?.n ?? 0,
    storageBytes: Number(docs[0]?.bytes ?? 0),
    activeUsers: users[0]?.n ?? 0,
  };
}

/** What a LIMIT capability counts, from a usage snapshot. */
export function usedFor(capability: string, usage: ApiUsage): number | null {
  switch (capability) {
    case 'invoice.monthly_limit':
      return usage.invoicesThisMonth;
    case 'users.max':
      return usage.activeUsers;
    case 'storage.max_bytes':
      return usage.storageBytes;
    default:
      return null;
  }
}
