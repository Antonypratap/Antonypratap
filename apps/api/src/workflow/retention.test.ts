import { afterEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { renderScenario, scenarioById } from '@veyra/extractor';
import { scriptedConnector, type ErpScript } from '@veyra/erp-connector/testing';
import * as t from '../db/schema';
import { ulid } from '../ids';
import { createHarness, DEMO_NOW, type Harness } from '../test/harness';
import { DEMO_USER, type RetentionPolicy } from './veyra';

/**
 * Customer-controlled retention of ORIGINAL invoice documents. The invariant under test: a
 * document is deleted automatically only after the invoice completed successfully (every check
 * passed and the ERP write was confirmed), and deleting it never deletes the invoice record or
 * its audit trail. Synthetic scenarios only.
 */
let h: Harness;
let script: ErpScript;
afterEach(async () => {
  await h?.close();
});

async function start() {
  h = await createHarness({
    wrapErp: (erp) => {
      const s = scriptedConnector(erp);
      script = s.script;
      return s.connector;
    },
  });
}

const policy = (p: RetentionPolicy) => h.veyra.setRetentionPolicy(p, DEMO_USER.id);
const AFTER_SUCCESS: RetentionPolicy = { mode: 'DELETE_AFTER_SUCCESS', days: null };

async function upload(scenario: string): Promise<string> {
  const s = scenarioById(scenario);
  if (!s) throw new Error(scenario);
  return (await h.veyra.upload({ filename: s.file, bytes: renderScenario(s) })).invoiceId;
}
async function documentOf(invoiceId: string) {
  const row = (
    await h.veyra.db
      .select()
      .from(t.documents)
      .innerJoin(t.invoices, eq(t.invoices.documentId, t.documents.id))
      .where(eq(t.invoices.id, invoiceId))
  )[0];
  if (!row) throw new Error('no document');
  return row.documents;
}
const fileExists = async (invoiceId: string) =>
  h.veyra.storage.exists(h.veyra.documentKey(await documentOf(invoiceId)));
const deletions = async (invoiceId: string) =>
  h.veyra.db
    .select()
    .from(t.auditEvents)
    .where(and(eq(t.auditEvents.invoiceId, invoiceId), eq(t.auditEvents.event, 'document.deleted')))
    .orderBy(asc(t.auditEvents.seq));
/** The test clock is frozen: make delayed retries due now, then run them. */
async function runDueRetries(): Promise<void> {
  await h.veyra.db
    .update(t.jobs)
    .set({ runAfter: '2000-01-01T00:00:00.000Z' })
    .where(eq(t.jobs.type, 'commit'));
  await h.runner.drain();
}

describe('original document retention', () => {
  it('KEEP (the default): processed and recorded, the document stays', async () => {
    await start();
    expect(await h.veyra.retentionPolicy()).toEqual({ mode: 'KEEP', days: null });
    const id = await upload('S01');
    await h.runner.drain();
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
    expect((await documentOf(id)).status).toBe('AVAILABLE');
    expect(await fileExists(id)).toBe(true);
    expect((await h.veyra.latestJobs(id)).some((j) => j.type === 'retention')).toBe(false);
  });

  it('a new policy applies to new uploads only, never retroactively', async () => {
    await start();
    const id = await upload('S01'); // uploaded under KEEP
    await policy(AFTER_SUCCESS);
    await h.runner.drain();
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
    expect((await documentOf(id)).status).toBe('AVAILABLE');
  });

  it('DELETE_AFTER_SUCCESS: deleted once the ERP confirmed the record; the invoice record stays', async () => {
    await start();
    await policy(AFTER_SUCCESS);
    const id = await upload('S01');
    await h.runner.drain();
    const inv = await h.veyra.invoiceRow(h.veyra.db, id);
    expect(inv.state).toBe('VERIFIED_PENDING_PAYMENT');
    expect(inv.erpPurchaseInvoiceId).toBeTruthy();
    const doc = await documentOf(id);
    expect(doc).toMatchObject({ status: 'DELETED', deletedAt: DEMO_NOW.toISOString() });
    expect(await fileExists(id)).toBe(false); // the file itself is gone from storage
    // The processing record and its audit trail remain.
    expect((await h.veyra.loadFields(h.veyra.db, id)).size).toBeGreaterThan(0);
    const [event] = await deletions(id);
    expect(event).toMatchObject({ actorType: 'system', actorUserId: null });
    const detail = JSON.parse(event?.detailJson ?? '{}') as Record<string, unknown>;
    expect(detail).toMatchObject({
      documentId: doc.id,
      policy: 'DELETE_AFTER_SUCCESS',
      invoiceState: 'VERIFIED_PENDING_PAYMENT',
    });
    expect(String(detail.delivery)).toContain('recorded in the ERP');
    expect(event?.detailJson).not.toMatch(/JVBER|base64/); // never the document's contents
  });

  it('DELETE_AFTER_SUCCESS + the ERP failing: the document stays for a retry', async () => {
    await start();
    await policy(AFTER_SUCCESS);
    const id = await upload('S01');
    await h.runner.step(); // validated: COMMITTING
    script.fail('recordPurchaseInvoice', 'unavailable', 100);
    for (let i = 0; i < 6; i++) await runDueRetries();
    expect(await h.state(id)).not.toBe('VERIFIED_PENDING_PAYMENT');
    expect((await documentOf(id)).status).toBe('AVAILABLE');
    expect(await fileExists(id)).toBe(true);
    expect(await deletions(id)).toHaveLength(0);
  });

  it('DELETE_AFTER_SUCCESS + a question for the user: the document stays', async () => {
    await start();
    await policy(AFTER_SUCCESS);
    const id = await upload('S03');
    await h.runner.drain();
    expect(await h.state(id)).toBe('NEEDS_INPUT');
    expect((await documentOf(id)).status).toBe('AVAILABLE');
    expect(await fileExists(id)).toBe(true);
  });

  it('DELETE_AFTER_SUCCESS + a retried ERP write: deleted only after the write succeeded, once', async () => {
    await start();
    await policy(AFTER_SUCCESS);
    const id = await upload('S01');
    await h.runner.step();
    script.fail('recordPurchaseInvoice', 'timeout_before_write');
    await h.runner.drain();
    expect(await h.state(id)).toBe('COMMITTING');
    expect((await documentOf(id)).status).toBe('AVAILABLE');
    await runDueRetries();
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
    expect((await documentOf(id)).status).toBe('DELETED');
    // Running the retention job again (a duplicate or a retry) changes nothing.
    await h.veyra.runRetention(id);
    await h.veyra.runRetention(id);
    expect(await deletions(id)).toHaveLength(1);
  });

  it('DELETE_AFTER_DAYS: kept before the period ends, deleted once it has', async () => {
    await start();
    await policy({ mode: 'DELETE_AFTER_DAYS', days: 30 });
    const id = await upload('S01');
    await h.runner.drain();
    expect(await h.state(id)).toBe('VERIFIED_PENDING_PAYMENT');
    expect((await documentOf(id)).status).toBe('AVAILABLE');
    const job = (await h.veyra.latestJobs(id)).find((j) => j.type === 'retention');
    expect(job).toMatchObject({
      status: 'queued',
      runAfter: new Date(DEMO_NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    // Run early (as a worker would only after the date): still not due, so nothing is deleted.
    await h.veyra.runRetention(id);
    expect((await documentOf(id)).status).toBe('AVAILABLE');
    // 31 days later.
    const doc = await documentOf(id);
    await h.veyra.db
      .update(t.documents)
      .set({ uploadedAt: new Date(DEMO_NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString() })
      .where(eq(t.documents.id, doc.id));
    await h.veyra.db
      .update(t.jobs)
      .set({ runAfter: '2000-01-01T00:00:00.000Z' })
      .where(eq(t.jobs.type, 'retention'));
    await h.runner.drain();
    expect((await documentOf(id)).status).toBe('DELETED');
    expect(await fileExists(id)).toBe(false);
    expect(JSON.parse((await deletions(id))[0]?.detailJson ?? '{}')).toMatchObject({
      policy: 'DELETE_AFTER_DAYS',
    });
  });

  it('a person deletes the document: the invoice stays as it was; again is a no-op', async () => {
    await start();
    const id = await upload('S03');
    await h.runner.drain();
    expect(await h.state(id)).toBe('NEEDS_INPUT');
    expect(await h.veyra.deleteDocument(id, DEMO_USER.id, 'Not needed here')).toBe(true);
    expect((await documentOf(id)).status).toBe('DELETED');
    expect(await fileExists(id)).toBe(false);
    expect(await h.state(id)).toBe('NEEDS_INPUT');
    const [event] = await deletions(id);
    expect(event).toMatchObject({ actorType: 'user', actorUserId: DEMO_USER.id });
    expect(JSON.parse(event?.detailJson ?? '{}')).toMatchObject({
      reason: 'Not needed here',
      policy: 'MANUAL',
      invoiceState: 'NEEDS_INPUT',
    });
    // Already deleted (and the file already missing): no error, no second event, no job loop.
    expect(await h.veyra.deleteDocument(id, DEMO_USER.id)).toBe(false);
    await h.veyra.runRetention(id);
    expect(await deletions(id)).toHaveLength(1);
    // It cannot be read again: reprocessing a deleted original is refused, plainly.
    await h.veyra.db.update(t.invoices).set({ state: 'FAILED' }).where(eq(t.invoices.id, id));
    await expect(h.veyra.reprocess(id, DEMO_USER.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('never while Veyrafy is working on the invoice', async () => {
    await start();
    const id = await upload('S01'); // queued, not yet read
    await expect(h.veyra.deleteDocument(id, DEMO_USER.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect((await documentOf(id)).status).toBe('AVAILABLE');
  });

  it('only an administrator may change the policy or delete a document', async () => {
    await start();
    const financeId = ulid();
    const now = DEMO_NOW.toISOString();
    await h.veyra.db.insert(t.users).values({
      id: financeId,
      name: 'Finance',
      email: 'finance@test.invalid',
      active: true,
      organizationId: h.veyra.organizationId,
      role: 'FINANCE',
      passwordHash: null,
      createdAt: now,
      updatedAt: now,
    });
    await expect(h.veyra.setRetentionPolicy(AFTER_SUCCESS, financeId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const id = await upload('S03');
    await h.runner.drain();
    await expect(h.veyra.deleteDocument(id, financeId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await documentOf(id)).status).toBe('AVAILABLE');
    // Out-of-range days are refused; a change is audited.
    await expect(policy({ mode: 'DELETE_AFTER_DAYS', days: 0 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await policy({ mode: 'DELETE_AFTER_DAYS', days: 90 });
    const changed = await h.veyra.db
      .select()
      .from(t.auditEvents)
      .where(eq(t.auditEvents.event, 'settings.changed'));
    expect(JSON.parse(changed.at(-1)?.detailJson ?? '{}')).toMatchObject({
      setting: 'document_retention',
      to: { mode: 'DELETE_AFTER_DAYS', days: 90 },
    });
  });
});
