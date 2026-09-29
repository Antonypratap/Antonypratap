import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { renderScenario, scenarioById } from '@veyra/extractor';
import { purchaseInvoiceIdempotencyKey, type InvoiceId } from '@veyra/shared';
import * as t from '../db/schema';
import { createHarness, type Harness } from '../test/harness';
import { CrashSignal } from './commit';
import { InvalidTransitionError, assertTransition } from './state-machine';
import { DEMO_USER, VeyraError } from './veyra';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const grn = (date: string, received: string, accepted = received, poLineNo = 1) => ({
  grnDate: date,
  lines: [{ poLineNo, received, accepted }],
});
/** The invoice's audit trail and staged creations, in the order they were written. */
const audit = (id: string) =>
  h.veyra.db
    .select()
    .from(t.auditEvents)
    .where(eq(t.auditEvents.invoiceId, id))
    .orderBy(asc(t.auditEvents.seq));
const actions = (id: string) =>
  h.veyra.db
    .select()
    .from(t.creationActions)
    .where(eq(t.creationActions.invoiceId, id))
    .orderBy(asc(t.creationActions.seq));

describe('end to end: upload → … → VERIFIED_PENDING_PAYMENT', () => {
  it('S01 clean invoice verifies automatically, with no human step and no payment', async () => {
    h = await createHarness();
    const id = await h.upload('S01');
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
    const [pi] = await h.erp.listPurchaseInvoices();
    expect(pi).toMatchObject({
      vendorInvoiceNo: 'SSS/26-27/0451',
      totalPaise: 11_387_000,
      status: 'verified_pending_payment',
      veyraInvoiceId: id,
    });
    const events = (await audit(id)).map((e) => e.event);
    expect(events).toEqual(
      expect.arrayContaining([
        'invoice.uploaded',
        'extraction.completed',
        'match.recorded',
        'validation.completed',
        'commit.completed',
      ]),
    );
    expect((await audit(id)).find((e) => e.event === 'extraction.completed')?.actorType).toBe('ai');
    const states = (await audit(id))
      .filter((e) => e.event === 'invoice.state_changed')
      .map((e) => e.toState);
    expect(states).toEqual([
      'EXTRACTING',
      'MATCHING',
      'RESOLVING',
      'VALIDATING',
      'COMMITTING',
      'VERIFIED_PENDING_PAYMENT',
    ]);
  });

  it('S03 new vendor: auto vendor + auto PO, GRN only by confirmation, all written at commit', async () => {
    h = await createHarness();
    const id = await h.upload('S03');
    expect(await h.state(id)).toBe('NEEDS_INPUT');
    // Nothing reaches the ERP before the whole transaction is valid.
    expect(await h.erp.findVendorsByNormalizedName('nandi stationers')).toEqual([]);
    await h.answer(id, 'CA_GRN', 'confirm', grn('2026-09-17', '40'));
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
    const [vendor] = await h.erp.findVendorsByNormalizedName('nandi stationers');
    expect(vendor).toMatchObject({ origin: 'created_by_veyra', sourceInvoiceId: id });
    const po = (await h.erp.listPurchaseOrders()).find(
      (p) => p.origin === 'auto_created_from_invoice',
    );
    expect(po?.poNumber).toMatch(/^AUTO\/2026-27\//);
    const grns = await h.erp.listGrnsForPo(po?.id as never);
    expect(grns[0]).toMatchObject({
      origin: 'user_confirmed_via_veyra',
      confirmedByUserId: DEMO_USER.id,
      grnDate: '2026-09-17',
    });
    const last = await h.veyra.db
      .select()
      .from(t.validationResults)
      .where(eq(t.validationResults.invoiceId, id));
    const maxRun = Math.max(...last.map((r) => r.runNo));
    for (const code of ['R21', 'R22', 'R23', 'R24'])
      expect(last.find((r) => r.runNo === maxRun && r.ruleCode === code)).toMatchObject({
        outcome: 'not_applicable',
        naReason: 'PO_DERIVED_FROM_INVOICE',
      });
  });

  it('S04 above threshold asks before creating a PO; the PO records the approver', async () => {
    h = await createHarness();
    const id = await h.upload('S04');
    await h.answer(id, 'CA_PO', 'approve');
    await h.answer(id, 'CA_GRN', 'confirm', grn('2026-09-18', '12'));
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
    const po = (await h.erp.listPurchaseOrders()).find((p) => p.sourceInvoiceId === id);
    expect(po).toMatchObject({
      origin: 'created_from_invoice_on_approval',
      approvedByUserId: DEMO_USER.id,
    });
  });

  it('S05 missing item: approved item, then the PO under the limit, then the receipt', async () => {
    h = await createHarness();
    const id = await h.upload('S05');
    await h.answer(id, 'CA_ITEM', 'approve', {
      name: 'Whiteboard Marker Box of 10',
      hsnSac: '9608',
      uom: 'BOX',
      gstRate: '18%',
    });
    expect((await h.openQuestions(id)).map((q) => q.code)).toEqual(['CA_GRN']);
    await h.answer(id, 'CA_GRN', 'confirm', grn('2026-09-19', '30'));
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
    expect(await h.erp.findItemsByHsn('9608')).toHaveLength(1);
  });

  it('S07 ambiguous open PO: the user picks, never Veyra', async () => {
    h = await createHarness();
    const id = await h.upload('S07');
    const q = (await h.openQuestions(id))[0];
    const pick = q?.options.find((o) => o.label === 'PO-2026-0106');
    await h.answer(id, 'AM_OPEN_PO', pick?.id ?? '');
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
  });

  it('S10 quantity differs → record additional receipt → verified', async () => {
    h = await createHarness();
    const id = await h.upload('S10');
    await h.answer(id, 'VF_R26', 'receipt');
    expect((await h.openQuestions(id)).map((q) => q.code)).toEqual(['CA_GRN']);
    await h.answer(id, 'CA_GRN', 'confirm', grn('2026-09-22', '20'));
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
  });

  it('S14 blurry total: the user enters it; it is marked human_corrected and re-validated', async () => {
    h = await createHarness();
    const id = await h.upload('S14');
    await h.answer(id, 'MD_FIELD', 'set:header.totalPaise', '16,048.00');
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
    const f = (
      await h.veyra.db
        .select()
        .from(t.extractedFields)
        .where(
          and(eq(t.extractedFields.invoiceId, id), eq(t.extractedFields.path, 'header.totalPaise')),
        )
        .limit(1)
    )[0];
    expect(f).toMatchObject({
      source: 'human_corrected',
      valueJson: '1604800',
      updatedByUserId: DEMO_USER.id,
    });
  });

  it('re-extraction (one batched write) keeps human values, row ids and order; refreshes the rest', async () => {
    const harness = await createHarness();
    h = harness;
    const id = await harness.upload('S14');
    await harness.answer(id, 'MD_FIELD', 'set:header.totalPaise', '16,048.00');
    const snapshot = async () =>
      (
        await harness.veyra.db
          .select()
          .from(t.extractedFields)
          .where(eq(t.extractedFields.invoiceId, id))
          .orderBy(asc(t.extractedFields.seq))
      ).filter((r) => r.extractionId !== null || r.source.startsWith('human'));
    const before = await snapshot();
    // Read the document again, as a reprocess does (state set back to EXTRACTING directly).
    await h.veyra.db.update(t.invoices).set({ state: 'EXTRACTING' }).where(eq(t.invoices.id, id));
    await (h.veyra as unknown as { read: (x: string) => Promise<boolean> }).read(id);
    const after = await snapshot();
    expect(after.map((r) => [r.id, r.seq, r.path])).toEqual(
      before.map((r) => [r.id, r.seq, r.path]),
    );
    const total = (rows: typeof before) => rows.find((r) => r.path === 'header.totalPaise');
    expect(total(after)).toEqual(total(before)); // the human value is untouched
    for (const r of after.filter((x) => x.source === 'extracted')) {
      const b = before.find((x) => x.path === r.path);
      expect({ ...r, extractionId: null, updatedAt: null }).toEqual({
        ...b,
        extractionId: null,
        updatedAt: null,
      });
      expect(r.extractionId).not.toBe(b?.extractionId); // written by the new reading
    }
    const lines = await h.veyra.db
      .select()
      .from(t.invoiceLines)
      .where(eq(t.invoiceLines.invoiceId, id));
    expect(new Set(lines.map((l) => l.lineNo)).size).toBe(lines.length);
  });

  it('S14 confirming the misread total does not verify it: the totals still have to agree', async () => {
    h = await createHarness();
    const id = await h.upload('S14');
    await h.answer(id, 'MD_FIELD', 'confirm');
    expect((await h.openQuestions(id)).map((q) => q.code)).toEqual(['VF_R09']);
  });

  it('S16 inactive vendor: reactivation is committed with the invoice', async () => {
    h = await createHarness();
    const id = await h.upload('S16');
    expect((await h.erp.getVendor('V003' as never))?.status).toBe('inactive');
    await h.answer(id, 'BD_VENDOR_INACTIVE', 'reactivate');
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
    expect((await h.erp.getVendor('V003' as never))?.status).toBe('active');
  });

  it('S17 unreadable GSTIN: picking V005 verifies; picking V006 fails the PO vendor check', async () => {
    h = await createHarness();
    const id = await h.upload('S17');
    await h.answer(id, 'AM_VENDOR', 'vendor:V005');
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
    await h.close();
    h = await createHarness();
    const other = await h.upload('S17');
    await h.answer(other, 'AM_VENDOR', 'vendor:V006');
    expect((await h.openQuestions(other)).map((q) => q.code)).toEqual(['VF_R18']);
  });

  it('S19 unit mismatch: no conversion is invented; correcting a misread unit re-validates', async () => {
    h = await createHarness();
    const id = await h.upload('S19');
    await h.answer(id, 'VF_R27', 'set:lines[1].uom', 'NOS');
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
  });
});

describe('rejection', () => {
  it('S09 one paisa: only correct, re-check or reject; reject is explicit and final', async () => {
    h = await createHarness();
    const id = await h.upload('S09');
    const q = (await h.openQuestions(id))[0];
    expect(q?.options.map((o) => o.id)).toEqual([
      'set:lines[1].unitPricePaise',
      'recheck',
      'reject',
    ]);
    await h.answer(id, 'VF_R21', 'reject');
    expect(await h.state(id)).toBe('REJECTED');
    expect(await h.veyra.invoiceRow(h.veyra.db, id)).toMatchObject({
      rejectedByUserId: DEMO_USER.id,
      rejectedReason: 'Reject this invoice',
    });
    expect(await h.erp.listPurchaseInvoices()).toEqual([]);
  });

  it('S08b short receipt then reject: the confirmed GRN never reaches the ERP but stays in the audit (D1)', async () => {
    h = await createHarness();
    const id = await h.upload('S08');
    await h.answer(id, 'CA_GRN', 'confirm', grn('2026-09-20', '50', '40'));
    expect((await h.openQuestions(id)).map((q) => q.code)).toEqual(['VF_R26']);
    await h.answer(id, 'VF_R26', 'reject');
    expect(await h.state(id)).toBe('REJECTED');
    expect(await h.erp.listGrnsForPo('PO-2026-0104' as never)).toEqual([]);
    expect((await actions(id)).map((a) => [a.entity, a.status])).toEqual([['grn', 'discarded']]);
    expect((await audit(id)).some((e) => e.event === 'creation.discarded')).toBe(true);
  });

  it('S06 cited PO not in the ERP: no PO is fabricated', async () => {
    h = await createHarness();
    const before = (await createHarnessErpPos()).length;
    const id = await h.upload('S06');
    await h.answer(id, 'VF_R17', 'reject');
    expect(await h.state(id)).toBe('REJECTED');
    expect((await h.erp.listPurchaseOrders()).length).toBe(before);
  });

  it('S11b business duplicate after S01 is asked, then rejected', async () => {
    h = await createHarness();
    await h.upload('S01');
    const dup = await h.upload('S11b');
    expect((await h.openQuestions(dup)).map((q) => q.code)).toEqual(['VF_R11']);
    await h.answer(dup, 'VF_R11', 'reject');
    expect(await h.state(dup)).toBe('REJECTED');
    expect(await h.erp.listPurchaseInvoices()).toHaveLength(1);
  });
});

async function createHarnessErpPos() {
  return h.erp.listPurchaseOrders();
}

describe('boundaries: the backend is authoritative', () => {
  it('refuses unknown options, bad input, answered questions and other users', async () => {
    h = await createHarness();
    const id = await h.upload('S08');
    const q = (await h.openQuestions(id))[0];
    if (!q) throw new Error('no question');
    const ans = (body: { optionId: string; input: unknown }, user: string = DEMO_USER.id) =>
      h.veyra.answer(q.id, body, user);
    await expect(ans({ optionId: 'override', input: null })).rejects.toThrow(
      /not one of the options/,
    );
    await expect(
      ans({ optionId: 'confirm', input: grn('2026-09-20', '50', '60') }),
    ).rejects.toThrow(/Accepted cannot be more/);
    await expect(ans({ optionId: 'confirm', input: grn('2026-10-20', '50') })).rejects.toThrow(
      /between the order date and today/,
    );
    await expect(
      ans({ optionId: 'confirm', input: grn('2026-09-20', '50') }, '01K00000000000000000000009'),
    ).rejects.toThrow(VeyraError);
    await h.answer(id, 'CA_GRN', 'confirm', grn('2026-09-20', '50'));
    await expect(ans({ optionId: 'confirm', input: grn('2026-09-20', '50') })).rejects.toThrow(
      /already been answered/,
    );
  });

  it('rejects files that are not invoices, and the same file twice', async () => {
    h = await createHarness();
    await expect(
      h.veyra.upload({ filename: 'x.pdf', bytes: new TextEncoder().encode('hello') }),
    ).rejects.toThrow(/PDF, JPEG or PNG/);
    const s = scenarioById('S01');
    if (!s) throw new Error('S01');
    await h.veyra.upload({ filename: s.file, bytes: renderScenario(s) });
    await expect(
      h.veyra.upload({ filename: 'again.pdf', bytes: renderScenario(s) }),
    ).rejects.toThrow(/already uploaded/);
  });

  it('an unknown document fails visibly; it can be retried or rejected, never guessed', async () => {
    h = await createHarness();
    const { invoiceId } = await h.veyra.upload({
      filename: 'scan.pdf',
      // A complete-looking PDF whose body is damaged: accepted, then unreadable.
      bytes: new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Garbage >>\ntrailer\n%%EOF\n'),
    });
    await h.runner.drain();
    expect(await h.veyra.invoiceRow(h.veyra.db, invoiceId)).toMatchObject({
      state: 'FAILED',
      failedStage: 'EXTRACTING',
    });
    await h.veyra.reprocess(invoiceId, DEMO_USER.id);
    await h.runner.drain();
    expect(await h.state(invoiceId)).toBe('FAILED');
    await h.veyra.reject(invoiceId, 'Not an invoice', DEMO_USER.id);
    expect(await h.state(invoiceId)).toBe('REJECTED');
  });

  it('illegal transitions throw; there is no transition out of the terminal states', () => {
    expect(() => assertTransition('NEEDS_INPUT', 'VERIFIED_PENDING_PAYMENT')).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertTransition('VERIFIED_PENDING_PAYMENT', 'MATCHING')).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertTransition('REJECTED', 'MATCHING')).toThrow(InvalidTransitionError);
  });

  it('NEEDS_INPUT waits indefinitely: nothing escalates or times out', async () => {
    h = await createHarness();
    const id = await h.upload('S09');
    for (let i = 0; i < 3; i++) await h.runner.drain();
    expect(await h.state(id)).toBe('NEEDS_INPUT');
    expect(await h.veyra.pendingJobs()).toBe(0);
  });
});

describe('idempotency and crash recovery', () => {
  it('running the same pipeline and commit jobs again creates nothing new', async () => {
    h = await createHarness();
    const id = await h.upload('S03');
    await h.answer(id, 'CA_GRN', 'confirm', grn('2026-09-17', '40'));
    const before = {
      pos: (await h.erp.listPurchaseOrders()).length,
      grns: (await h.erp.listGrns()).length,
      vendors: (await h.erp.listVendors()).length,
      invoices: (await h.erp.listPurchaseInvoices()).length,
    };
    await h.veyra.runPipeline(id);
    await h.veyra.runCommit(id);
    await h.veyra.db.transaction((tx) => h.veyra.enqueue(tx, id, 'pipeline'));
    await h.runner.drain();
    expect({
      pos: (await h.erp.listPurchaseOrders()).length,
      grns: (await h.erp.listGrns()).length,
      vendors: (await h.erp.listVendors()).length,
      invoices: (await h.erp.listPurchaseInvoices()).length,
    }).toEqual(before);
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
  });

  for (const crashAt of ['vendor', 'po', 'grn', 'purchase_invoice']) {
    it(`a crash right after the ERP wrote the ${crashAt} resumes without duplicates`, async () => {
      let armed = true;
      h = await createHarness({
        commitHooks: {
          afterErpWrite: (entity) => {
            if (armed && entity === crashAt) {
              armed = false;
              throw new CrashSignal(`after ${entity}`);
            }
          },
        },
      });
      const id = await h.upload('S03');
      const q = (await h.openQuestions(id))[0];
      await h.veyra.answer(
        q?.id ?? '',
        { optionId: 'confirm', input: grn('2026-09-17', '40') },
        DEMO_USER.id,
      );
      await expect(h.runner.drain()).rejects.toThrow(CrashSignal);
      expect(await h.state(id)).toBe('COMMITTING');

      h = await h.restart();
      // The restarted worker recovers the job once its lease has expired (the process died, so
      // nothing renewed it). Simulated here by ageing the lease instead of waiting.
      await h.veyra.db.update(t.jobs).set({ lockedAt: '2026-09-28T05:00:00.000Z' });
      expect(await h.runner.recoverExpired()).toBe(1);
      await h.runner.drain();
      expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
      expect(await h.erp.findVendorsByNormalizedName('nandi stationers')).toHaveLength(1);
      expect(
        (await h.erp.listPurchaseOrders()).filter((p) => p.sourceInvoiceId === id),
      ).toHaveLength(1);
      expect((await h.erp.listGrns()).filter((g) => g.sourceInvoiceId === id)).toHaveLength(1);
      expect(
        (await h.erp.listPurchaseInvoices()).filter((p) => p.veyraInvoiceId === id),
      ).toHaveLength(1);
    });
  }

  it('a transient ERP outage is retried with the same keys', async () => {
    let failures = 1;
    h = await createHarness({
      erpHooks: {
        failpoint: (name) => {
          if (name === 'purchase_invoice.header_inserted' && failures-- > 0)
            throw new Database.SqliteError('database is locked', 'SQLITE_BUSY');
        },
      },
    });
    const id = await h.upload('S01');
    const job = (await h.veyra.latestJobs(id)).find((j) => j.type === 'commit');
    expect(job).toMatchObject({ status: 'queued', attempts: 1 });
    expect(await h.state(id)).toBe('COMMITTING');
    await h.veyra.db
      .update(t.jobs)
      .set({ runAfter: '2000-01-01T00:00:00.000Z' })
      .where(eq(t.jobs.id, job?.id ?? ''));
    await h.runner.drain();
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
    expect(await h.erp.listPurchaseInvoices()).toHaveLength(1);
  });

  it('pre-commit re-check: if the ERP changed after validation, the invoice goes back to MATCHING', async () => {
    h = await createHarness();
    const s = scenarioById('S01');
    if (!s) throw new Error('S01');
    const { invoiceId } = await h.veyra.upload({ filename: s.file, bytes: renderScenario(s) });
    await h.runner.step(); // pipeline: validated, COMMITTING, commit job queued
    expect(await h.state(invoiceId)).toBe('COMMITTING');
    // Meanwhile someone records the same supplier invoice in the ERP directly.
    const outsider = '01K0000000000000000000ZZZZ' as InvoiceId;
    await h.erp.recordPurchaseInvoice(
      {
        vendorId: 'V001',
        vendorInvoiceNo: 'SSS/26-27/0451',
        invoiceDate: '2026-09-15',
        poId: 'PO-2026-0101',
        taxablePaise: 9_650_000,
        cgstPaise: 868_500,
        sgstPaise: 868_500,
        igstPaise: 0,
        roundOffPaise: null,
        totalPaise: 11_387_000,
        veyraInvoiceId: outsider,
        lines: [
          {
            lineNo: 1,
            poLineId: 'PO-2026-0101#1',
            itemId: 'ITM-001',
            qtyMilli: 1_000_000,
            unitPricePaise: 6250,
            taxablePaise: 6_250_000,
            gstRateBp: 1800,
            cgstPaise: null,
            sgstPaise: null,
            igstPaise: null,
          },
          {
            lineNo: 2,
            poLineId: 'PO-2026-0101#2',
            itemId: 'ITM-002',
            qtyMilli: 500_000,
            unitPricePaise: 6800,
            taxablePaise: 3_400_000,
            gstRateBp: 1800,
            cgstPaise: null,
            sgstPaise: null,
            igstPaise: null,
          },
        ],
      } as never,
      purchaseInvoiceIdempotencyKey(outsider),
    );
    await h.runner.drain();
    expect((await audit(invoiceId)).some((e) => e.event === 'commit.conflict')).toBe(true);
    expect(await h.state(invoiceId)).toBe('NEEDS_INPUT');
    expect((await h.openQuestions(invoiceId)).map((q) => q.code)).toEqual(['VF_R11']);
    expect(await h.erp.listPurchaseInvoices()).toHaveLength(1);
  });
});
