import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '../db/schema';
import { SecretBox } from '../erp-api/secrets';
import { ulid } from '../ids';
import { DEMO_NOW } from '../test/harness';
import { createTestApp } from '../test/app';
import { isSealed, sealedKeyId } from '../storage/encrypted';
import {
  EncryptedDocumentStorage,
  Keyring,
  LocalDocumentStorage,
  type DocumentStorage,
} from '../storage';
import { NotEncryptedStorageError, encryptExisting } from './encrypt-existing';

/**
 * The migration that brings data stored before encryption at rest under it, and key rotation.
 * The app first runs WITHOUT encryption (as an existing deployment did), with made-up documents;
 * the tool then encrypts everything, verified, resumable, and reporting counts only.
 */

const DOCS = new URL('../../../../fixtures/documents/', import.meta.url);
const doc = (file: string) => new Uint8Array(readFileSync(new URL(file, DOCS)));
const K1 = randomBytes(32).toString('base64');
const K2 = randomBytes(32).toString('base64');

let app: Awaited<ReturnType<typeof createTestApp>>;
let dir: string;
let local: LocalDocumentStorage;
const uploads = () => join(dir, 'uploads');
const encrypted = (keys: string, active: string, requireEncrypted = false) =>
  new EncryptedDocumentStorage(local, { keyring: Keyring.parse(keys, active), requireEncrypted });
const storageFor =
  (keys: string, active: string) =>
  (d: string): DocumentStorage =>
    new EncryptedDocumentStorage(new LocalDocumentStorage(d), {
      keyring: Keyring.parse(keys, active),
      requireEncrypted: false,
    });
let documentKey = '';
let legacyRecordId = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'veyra-migrate-enc-'));
  local = new LocalDocumentStorage(uploads());
  app = await createTestApp({
    dataDir: dir,
    demo: true,
    allowFixtureExtractor: true,
    nodeEnv: 'test',
    clock: () => DEMO_NOW,
    storage: local, // no encryption yet: the state of an existing deployment
  });
  app.runner.stop();
  const { documentId } = await app.veyra.upload({
    filename: 'D01-clean-text.pdf',
    bytes: doc('D01-clean-text.pdf'),
  });
  const [d] = await app.veyra.db.select().from(t.documents).where(eq(t.documents.id, documentId));
  documentKey = d?.storagePath ?? '';
  // An ERP record imported by an older version: its invoice held in the database as base64.
  legacyRecordId = ulid();
  await app.veyra.db.insert(t.erpReceiptRecords).values({
    id: legacyRecordId,
    invoiceNoKey: 'MU/0042',
    vendorName: 'Made-up Supplies',
    grnNo: '501',
    recordJson: '{}',
    attachmentName: 'MU-0042.pdf',
    attachmentBase64: Buffer.from(doc('D12-missing-receipt.pdf')).toString('base64'),
    sourceFilename: 'made-up-export.json',
    importedByUserId: app.session.userId,
    importedAt: DEMO_NOW.toISOString(),
  });
  // A stray file in the storage folder (no database row): encrypted too.
  writeFileSync(join(uploads(), 'stray.bin'), 'made-up stray bytes');
}, 60_000);
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (o: {
  storage: DocumentStorage;
  dryRun?: boolean;
  rewrap?: boolean;
  keys?: string;
  active?: string;
  secrets?: SecretBox | null;
}) =>
  encryptExisting({
    db: app.veyra.db,
    storage: o.storage,
    storageFor: storageFor(o.keys ?? `k1:${K1}`, o.active ?? 'k1'),
    storageDir: uploads(),
    challengesDir: join(dir, 'challenges'),
    secrets: o.secrets ?? null,
    dryRun: o.dryRun ?? false,
    rewrap: o.rewrap ?? false,
  });

describe('encrypting existing data', () => {
  it('refuses to run when storage is not encrypted', async () => {
    await expect(run({ storage: local })).rejects.toBeInstanceOf(NotEncryptedStorageError);
  });

  it('a dry run reports what would change and changes nothing', async () => {
    const before = readFileSync(local.pathOf(documentKey));
    const report = await run({ storage: encrypted(`k1:${K1}`, 'k1'), dryRun: true });
    expect(report.documents).toMatchObject({ changed: 1, done: 0 });
    expect(report.erpAttachments.changed).toBe(1);
    expect(report.otherFiles.changed).toBe(1);
    expect(readFileSync(local.pathOf(documentKey)).equals(before)).toBe(true);
    const [r] = await app.veyra.db
      .select()
      .from(t.erpReceiptRecords)
      .where(eq(t.erpReceiptRecords.id, legacyRecordId));
    expect(r?.attachmentBase64).not.toBeNull();
    // Counts only: the report names no file and holds no content.
    expect(JSON.stringify(report)).not.toMatch(/pdf|stray|erp-attachments/);
  });

  it('encrypts every file (verified), moves database-held invoices out, and audits counts only', async () => {
    const report = await run({ storage: encrypted(`k1:${K1}`, 'k1') });
    expect(report.documents).toMatchObject({ changed: 1, mismatched: 0, missing: 0 });
    expect(report.erpAttachments.changed).toBe(1);
    expect(report.otherFiles.changed).toBe(1);
    expect(isSealed(readFileSync(local.pathOf(documentKey)))).toBe(true);
    expect(isSealed(readFileSync(join(uploads(), 'stray.bin')))).toBe(true);

    const [r] = await app.veyra.db
      .select()
      .from(t.erpReceiptRecords)
      .where(eq(t.erpReceiptRecords.id, legacyRecordId));
    expect(r?.attachmentBase64).toBeNull();
    expect(r?.attachmentKey).toBe(`erp-attachments/${legacyRecordId}`);

    // With encryption now required, everything reads back to the original bytes.
    const strict = encrypted(`k1:${K1}`, 'k1', true);
    expect(Buffer.from(await strict.get(documentKey))).toEqual(
      Buffer.from(doc('D01-clean-text.pdf')),
    );
    expect(
      Buffer.from(await strict.get(r?.attachmentKey ?? '', { sha256: r?.attachmentSha256 ?? '' })),
    ).toEqual(Buffer.from(doc('D12-missing-receipt.pdf')));

    const audits = await app.veyra.db
      .select()
      .from(t.auditEvents)
      .where(eq(t.auditEvents.event, 'security.data_encrypted'));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detailJson).not.toMatch(/pdf|stray|erp-attachments/);
  });

  it('is resumable and idempotent: a second run changes nothing', async () => {
    const report = await run({ storage: encrypted(`k1:${K1}`, 'k1') });
    expect(report.documents).toMatchObject({ changed: 0, done: 1 });
    expect(report.erpAttachments).toMatchObject({ changed: 0, done: 1 });
    expect(report.otherFiles).toMatchObject({ changed: 0, done: 1 });
  });

  it('rotation: every file moves to the new key and credentials to the new secrets key', async () => {
    // A saved ERP credential, sealed with the old secrets key.
    const oldSecrets = randomBytes(32).toString('base64');
    const newSecrets = randomBytes(32).toString('base64');
    const sealed = SecretBox.fromBase64(oldSecrets).seal('made-up-key', 'erp:erp-api:apiKey');
    await app.veyra.db.insert(t.erpConnections).values({
      id: 'erp-api',
      profileJson: '{}',
      active: false,
      version: 1,
      updatedByUserId: null,
      updatedAt: DEMO_NOW.toISOString(),
    });
    await app.veyra.db.insert(t.erpCredentials).values({
      connectionId: 'erp-api',
      name: 'apiKey',
      ...sealed,
      updatedByUserId: null,
      updatedAt: DEMO_NOW.toISOString(),
    });
    const keys = `k1:${K1},k2:${K2}`;
    const secrets = SecretBox.fromBase64(newSecrets, oldSecrets);
    const dry = await run({
      storage: encrypted(keys, 'k2'),
      keys,
      active: 'k2',
      rewrap: true,
      dryRun: true,
      secrets,
    });
    expect(dry.rewrapped).toBe(3);
    expect(dry.credentialsResealed).toBe(1);
    const report = await run({
      storage: encrypted(keys, 'k2'),
      keys,
      active: 'k2',
      rewrap: true,
      secrets,
    });
    expect(report.rewrapped).toBe(3);
    expect(report.credentialsResealed).toBe(1);
    expect(sealedKeyId(readFileSync(local.pathOf(documentKey)))).toBe('k2');
    // The old keys can now be removed: the new ones alone read everything.
    const onlyNew = encrypted(`k2:${K2}`, 'k2', true);
    expect(Buffer.from(await onlyNew.get(documentKey))).toEqual(
      Buffer.from(doc('D01-clean-text.pdf')),
    );
    const [cred] = await app.veyra.db.select().from(t.erpCredentials);
    if (!cred) throw new Error('expected the saved credential');
    expect(SecretBox.fromBase64(newSecrets).open(cred, 'erp:erp-api:apiKey').reveal()).toBe(
      'made-up-key',
    );
  });

  it('a file that no longer matches its recorded checksum is left untouched and reported', async () => {
    const { documentId } = await app.veyra.upload({
      filename: 'D07-quantity-mismatch.pdf',
      bytes: doc('D07-quantity-mismatch.pdf'),
    });
    const [d] = await app.veyra.db.select().from(t.documents).where(eq(t.documents.id, documentId));
    // Written unencrypted (as before the switch), then damaged on disk.
    const key = d?.storagePath ?? '';
    writeFileSync(local.pathOf(key), 'damaged');
    const report = await run({
      storage: encrypted(`k2:${K2}`, 'k2'),
      keys: `k2:${K2}`,
      active: 'k2',
    });
    expect(report.documents.mismatched).toBe(1);
    expect(readFileSync(local.pathOf(key), 'utf8')).toBe('damaged');
  });
});
