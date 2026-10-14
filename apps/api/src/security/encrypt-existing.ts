import { readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { VeyraDb } from '../db/open';
import * as t from '../db/schema';
import { ulid } from '../ids';
import type { SecretBox } from '../erp-api/secrets';
import { sealedKeyId } from '../storage/encrypted';
import {
  EncryptedDocumentStorage,
  StorageNotFoundError,
  sha256Hex,
  type DocumentStorage,
} from '../storage';

/**
 * Brings data stored before encryption at rest under it, and rotates keys
 * (`npm run security:encrypt-existing`, docs/SECURITY.md "Encryption at rest").
 *
 * - Documents and imported files: encrypted in place, each verified against the SHA-256 recorded
 *   at upload before and after (a file that no longer matches is left alone and counted).
 * - ERP-attached invoices still held in the database as base64: written to encrypted storage,
 *   read back and verified, and only then removed from the database (one row at a time).
 * - Any other file under the storage folders (Invoice Challenge workspaces, which keep their own
 *   databases): encrypted in place and read back.
 * - `rewrap`: every encrypted file's data key is re-wrapped with the active key, and saved ERP
 *   credentials are re-encrypted with the current VEYRA_SECRETS_KEY, so the old keys can go.
 *
 * Resumable and idempotent: anything already done is skipped, so it can be stopped and run again.
 * `dryRun` changes nothing and reports what would change. It reports counts only: never a
 * filename, a key or any content. Every run that changes something is audited (counts only).
 */

export interface EncryptExistingOptions {
  db: VeyraDb;
  storage: DocumentStorage;
  /** Storage for another folder (challenge workspaces), encrypted with the same keys. */
  storageFor: (dir: string) => DocumentStorage;
  /** The folder documents are stored in, and the folder challenge workspaces live in. */
  storageDir: string;
  challengesDir: string | null;
  /** ERP credentials (rewrap only): the current key with the previous ones. */
  secrets?: SecretBox | null;
  dryRun: boolean;
  rewrap: boolean;
  now?: () => string;
}

export interface EncryptExistingReport {
  dryRun: boolean;
  documents: Counts;
  imports: Counts;
  erpAttachments: Counts;
  otherFiles: Counts;
  rewrapped: number;
  credentialsResealed: number;
}

export interface Counts {
  /** Already encrypted (or, for ERP attachments, already in storage). */
  done: number;
  /** Encrypted or moved by this run (or that would be, in a dry run). */
  changed: number;
  /** Not found in storage: nothing to encrypt (reported, not an error). */
  missing: number;
  /** Did not match its recorded checksum: left untouched for a person to look at. */
  mismatched: number;
}

const counts = (): Counts => ({ done: 0, changed: 0, missing: 0, mismatched: 0 });

export class NotEncryptedStorageError extends Error {
  constructor() {
    super(
      'Document storage is not encrypted: set VEYRA_DATA_KEYS and VEYRA_DATA_KEY_ACTIVE first (docs/SECURITY.md).',
    );
    this.name = 'NotEncryptedStorageError';
  }
}

function asEncrypted(s: DocumentStorage): EncryptedDocumentStorage {
  if (!(s instanceof EncryptedDocumentStorage)) throw new NotEncryptedStorageError();
  return s;
}

const documentKey = (storagePath: string) =>
  isAbsolute(storagePath) ? basename(storagePath) : storagePath;

/** Every file under `root`, as storage keys (relative, `/`-separated). Skips temporary files. */
function filesUnder(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true }).map(String);
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.endsWith('.partial') && statSync(join(root, e)).isFile())
    .map((e) => relative(root, join(root, e)).split(sep).join('/'));
}

export async function encryptExisting(o: EncryptExistingOptions): Promise<EncryptExistingReport> {
  const storage = asEncrypted(o.storage);
  const report: EncryptExistingReport = {
    dryRun: o.dryRun,
    documents: counts(),
    imports: counts(),
    erpAttachments: counts(),
    otherFiles: counts(),
    rewrapped: 0,
    credentialsResealed: 0,
  };
  const seen = new Set<string>();

  /** Encrypts one object in place, verified against its checksum when there is one. */
  const one = async (
    s: EncryptedDocumentStorage,
    key: string,
    sha256: string | null,
    c: Counts,
  ): Promise<void> => {
    try {
      if (await s.isEncrypted(key)) {
        c.done++;
        return;
      }
      if (o.dryRun) {
        // Verify now, so a dry run reports mismatches too.
        const plain = await s.inner.get(key);
        if (sha256 && sha256Hex(plain) !== sha256) c.mismatched++;
        else c.changed++;
        return;
      }
      await s.encryptExisting(key, sha256 ? { sha256 } : undefined);
      c.changed++;
    } catch (e) {
      if (e instanceof StorageNotFoundError) c.missing++;
      else if ((e as { code?: string }).code === 'STORAGE_INTEGRITY') c.mismatched++;
      else throw e;
    }
  };

  // 1. Documents (invoices), checked against the SHA-256 recorded at upload.
  for (const d of await o.db
    .select()
    .from(t.documents)
    .where(eq(t.documents.status, 'AVAILABLE'))) {
    const key = documentKey(d.storagePath);
    seen.add(key);
    await one(storage, key, d.sha256, report.documents);
  }

  // 2. Imported files (spreadsheets, ERP exports).
  for (const i of await o.db.select().from(t.imports)) {
    for (const f of JSON.parse(i.filesJson) as { key?: string; sha256?: string }[]) {
      if (!f.key) continue;
      seen.add(f.key);
      await one(storage, f.key, f.sha256 ?? null, report.imports);
    }
  }

  // 3. ERP-attached invoices: already in storage, or moved out of the database now.
  for (const r of await o.db
    .select()
    .from(t.erpReceiptRecords)
    .where(isNotNull(t.erpReceiptRecords.attachmentKey))) {
    seen.add(r.attachmentKey ?? '');
    await one(storage, r.attachmentKey ?? '', r.attachmentSha256, report.erpAttachments);
  }
  for (const r of await o.db
    .select()
    .from(t.erpReceiptRecords)
    .where(
      and(
        isNull(t.erpReceiptRecords.attachmentKey),
        isNotNull(t.erpReceiptRecords.attachmentBase64),
      ),
    )) {
    if (o.dryRun) {
      report.erpAttachments.changed++;
      continue;
    }
    const bytes = new Uint8Array(Buffer.from(r.attachmentBase64 ?? '', 'base64'));
    const key = `erp-attachments/${r.id}`;
    const sha256 = sha256Hex(bytes);
    await storage.put(key, bytes, { mime: 'application/octet-stream', sha256 });
    await storage.get(key, { sha256 }); // read back through decryption before the copy goes
    seen.add(key);
    await o.db
      .update(t.erpReceiptRecords)
      .set({ attachmentKey: key, attachmentSha256: sha256, attachmentBase64: null })
      .where(and(eq(t.erpReceiptRecords.id, r.id), isNull(t.erpReceiptRecords.attachmentKey)));
    report.erpAttachments.changed++;
  }

  // 4. Any other file in the storage folders (and the challenge workspaces' own folders).
  const folders: { storage: EncryptedDocumentStorage; root: string; main: boolean }[] = [
    { storage, root: o.storageDir, main: true },
  ];
  if (o.challengesDir)
    for (const ws of (() => {
      try {
        return readdirSync(o.challengesDir);
      } catch {
        return [];
      }
    })()) {
      const root = join(o.challengesDir, ws, 'uploads');
      folders.push({ storage: asEncrypted(o.storageFor(root)), root, main: false });
    }
  for (const f of folders)
    for (const key of filesUnder(f.root)) {
      if (f.main && seen.has(key)) continue;
      await one(f.storage, key, null, report.otherFiles);
    }

  // 5. Rotation: every encrypted file to the active key; credentials to the current key.
  if (o.rewrap) {
    for (const f of folders)
      for (const key of filesUnder(f.root)) {
        if (!(await f.storage.isEncrypted(key))) continue;
        if (o.dryRun) {
          if (sealedKeyId(await f.storage.inner.get(key)) !== f.storage.options.keyring.activeId)
            report.rewrapped++;
        } else if (await f.storage.rewrapExisting(key)) report.rewrapped++;
      }
    if (o.secrets) {
      const box = o.secrets;
      const rows = (await o.db.select().from(t.erpCredentials)).filter((r) => box.isStale(r));
      if (!o.dryRun)
        await o.db.transaction(async (tx) => {
          for (const r of rows) {
            const purpose = `erp:${r.connectionId}:${r.name}`;
            await tx
              .update(t.erpCredentials)
              .set(box.seal(box.open(r, purpose).reveal(), purpose))
              .where(
                and(
                  eq(t.erpCredentials.connectionId, r.connectionId),
                  eq(t.erpCredentials.name, r.name),
                ),
              );
          }
        });
      report.credentialsResealed = rows.length;
    }
  }

  const changed =
    report.documents.changed +
    report.imports.changed +
    report.erpAttachments.changed +
    report.otherFiles.changed +
    report.rewrapped +
    report.credentialsResealed;
  if (!o.dryRun && changed > 0)
    await o.db.insert(t.auditEvents).values({
      id: ulid(),
      invoiceId: null,
      actorType: 'system',
      actorUserId: null,
      event: 'security.data_encrypted',
      fromState: null,
      toState: null,
      // Counts only: never a file name, a key or content.
      detailJson: JSON.stringify({
        documents: report.documents.changed,
        imports: report.imports.changed,
        erpAttachments: report.erpAttachments.changed,
        otherFiles: report.otherFiles.changed,
        rewrapped: report.rewrapped,
        credentialsResealed: report.credentialsResealed,
      }),
      createdAt: (o.now ?? (() => new Date().toISOString()))(),
    });
  return report;
}
