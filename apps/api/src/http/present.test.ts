import { afterEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { SCENARIOS } from '@veyra/extractor';
import * as t from '../db/schema';
import { createHarness, type Harness } from '../test/harness';
import { readField } from '../engine/fields';
import { DEMO_USER } from '../workflow/veyra';
import { Presenter, questionDto } from './present';

/**
 * Phase 7: the batched list views (inbox, questions) return exactly what the one-invoice-at-a-time
 * code returns, across every demo scenario, decisions, a rejection, a failure and an invoice still
 * being processed. Only the number of queries changed.
 */
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function representative(): Promise<Harness> {
  const harness = await createHarness();
  h = harness;
  for (const s of SCENARIOS) await harness.upload(s.id);
  // Decisions: confirm the goods receipt of S08, reject S09.
  const byScenario = async (file: string) =>
    (
      await harness.veyra.db
        .select({ id: t.invoices.id })
        .from(t.invoices)
        .innerJoin(t.documents, eq(t.documents.id, t.invoices.documentId))
        .where(eq(t.documents.filename, file))
    )[0]?.id ?? '';
  const s08id = await byScenario('S08-missing-grn.pdf');
  const q = (await harness.openQuestions(s08id)).find((x) => x.code === 'CA_GRN');
  const input = (
    JSON.parse(
      (
        await harness.veyra.db
          .select()
          .from(t.questions)
          .where(eq(t.questions.id, q?.id ?? ''))
      )[0]?.inputSchemaJson ?? '{}',
    ) as Record<string, { lines: { poLineNo: number; suggestedQty: string }[] } | undefined>
  ).confirm;
  await harness.answer(s08id, 'CA_GRN', 'confirm', {
    grnDate: '2026-09-20',
    lines: (input?.lines ?? []).map((l) => ({
      poLineNo: l.poLineNo,
      received: l.suggestedQty,
      accepted: l.suggestedQty,
    })),
  });
  await harness.veyra.reject(
    await byScenario('S09-price-differs.pdf'),
    'Price differs',
    DEMO_USER.id,
  );
  // A failed read, and one invoice left mid-processing (queued, not run).
  await harness.veyra.upload({
    filename: 'scan.pdf',
    bytes: new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Garbage >>\ntrailer\n%%EOF\n'),
  });
  await harness.runner.drain();
  await harness.veyra.upload({
    filename: 'late.pdf',
    bytes: new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Late >>\ntrailer\n%%EOF\n'),
  });
  return harness;
}

describe('batched list views (Phase 7)', () => {
  it('the inbox equals the per-invoice summaries, for every invoice and state', async () => {
    const harness = await representative();
    const p = new Presenter(harness.veyra);
    const rows = await harness.veyra.db
      .select()
      .from(t.invoices)
      .innerJoin(t.documents, eq(t.documents.id, t.invoices.documentId))
      .orderBy(desc(t.documents.uploadedAt), desc(t.invoices.seq));
    const oneByOne = [];
    for (const r of rows) oneByOne.push(await p.summary(r.invoices, r.documents));
    const inbox = await p.inbox();
    expect(inbox.invoices).toEqual(oneByOne);
    // The data really covers the cases: every UI status, decisions, notes, failures.
    const statuses = new Set(inbox.invoices.map((i) => i.status));
    for (const s of ['attention', 'processing', 'ready', 'handled', 'rejected'])
      expect(statuses).toContain(s);
    expect(inbox.invoices.some((i) => i.note?.startsWith('Matched to'))).toBe(true);
    expect(inbox.invoices.some((i) => i.decision !== null)).toBe(true);
    expect(inbox.invoices.some((i) => i.failure !== null)).toBe(true);
  });

  it('the question lists equal loading each question’s invoice fields one by one', async () => {
    const harness = await representative();
    const p = new Presenter(harness.veyra);
    for (const status of ['open', 'answered'] as const) {
      const rows = await harness.veyra.db
        .select()
        .from(t.questions)
        .where(eq(t.questions.status, status))
        .orderBy(status === 'open' ? t.questions.seq : desc(t.questions.answerSeq));
      const expected = [];
      for (const q of rows) {
        const f = await harness.veyra.loadFields(harness.veyra.db, q.invoiceId);
        // Exactly what the per-question code did: the displayed reading (confidence 0).
        const shown = (path: string) => readField(f, path as never, 0).value as never;
        expected.push(
          questionDto(q, {
            number: shown('header.invoiceNumber'),
            supplierName: shown('header.vendorName'),
            totalPaise: shown('header.totalPaise'),
          }),
        );
      }
      expect(rows.length).toBeGreaterThan(0);
      expect(await p.questions(status)).toEqual(expected);
    }
  });
});
