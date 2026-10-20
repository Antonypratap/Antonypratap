import { createHash, randomBytes } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { safeEqual } from '../auth/sessions';
import type { VeyraDb } from '../db/open';
import * as t from '../db/schema';
import { ulid } from '../ids';

/**
 * API clients: software that calls the verification API on the business's behalf (docs/VERIFY-API.md).
 *
 * A key looks like `vfy_<prefix>_<secret>`: the 8-character prefix finds the client, the whole key
 * is checked against its stored SHA-256 (a 256-bit random secret needs no slow hash), compared in
 * constant time. The key is shown once when created and never stored or logged. Revoked keys stop
 * working at once.
 */

export interface ApiClient {
  id: string;
  name: string;
}

const KEY = /^vfy_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;
const hash = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');

export class ApiClients {
  constructor(
    private readonly db: VeyraDb,
    private readonly now: () => string,
  ) {}

  /** A new client and its key (the only time the key exists outside the caller). */
  async create(name: string): Promise<{ id: string; name: string; key: string }> {
    const clean = name.trim();
    if (clean.length < 1 || clean.length > 100)
      throw new Error('The name must be 1–100 characters.');
    for (;;) {
      const prefix = randomBytes(8)
        .toString('base64url')
        .replace(/[^a-z0-9]/gi, '')
        .toLowerCase()
        .slice(0, 8);
      if (prefix.length < 8) continue;
      const key = `vfy_${prefix}_${randomBytes(32).toString('base64url')}`;
      const id = ulid();
      const taken = await this.db
        .select({ id: t.apiClients.id })
        .from(t.apiClients)
        .where(eq(t.apiClients.keyPrefix, prefix));
      if (taken.length) continue;
      await this.db.transaction(async (tx) => {
        await tx.insert(t.apiClients).values({
          id,
          name: clean,
          keyPrefix: prefix,
          keyHash: hash(key),
          status: 'active',
          createdAt: this.now(),
        });
        await audit(tx, 'api_client.created', { clientId: id, name: clean }, this.now());
      });
      return { id, name: clean, key };
    }
  }

  async revoke(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const done = await tx
        .update(t.apiClients)
        .set({ status: 'revoked', revokedAt: this.now() })
        .where(eq(t.apiClients.id, id))
        .returning({ id: t.apiClients.id });
      if (done.length) await audit(tx, 'api_client.revoked', { clientId: id }, this.now());
      return done.length > 0;
    });
  }

  async list() {
    return this.db
      .select({
        id: t.apiClients.id,
        name: t.apiClients.name,
        keyPrefix: t.apiClients.keyPrefix,
        status: t.apiClients.status,
        createdAt: t.apiClients.createdAt,
        revokedAt: t.apiClients.revokedAt,
        lastUsedAt: t.apiClients.lastUsedAt,
      })
      .from(t.apiClients)
      .orderBy(desc(t.apiClients.seq));
  }

  /** The active client a key belongs to, or null (malformed, unknown, revoked or wrong). */
  async authenticate(key: string): Promise<ApiClient | null> {
    const m = KEY.exec(key);
    if (!m) return null;
    const [row] = await this.db
      .select()
      .from(t.apiClients)
      .where(eq(t.apiClients.keyPrefix, m[1] ?? ''))
      .limit(1);
    if (!row || row.status !== 'active' || !safeEqual(hash(key), row.keyHash)) return null;
    // Last use, at most once a minute (not on every request).
    const now = this.now();
    if (!row.lastUsedAt || Date.parse(now) - Date.parse(row.lastUsedAt) > 60_000)
      await this.db
        .update(t.apiClients)
        .set({ lastUsedAt: now })
        .where(eq(t.apiClients.id, row.id))
        .catch(() => undefined);
    return { id: row.id, name: row.name };
  }
}

async function audit(
  db: Pick<VeyraDb, 'insert'>,
  event: string,
  detail: Record<string, unknown>,
  now: string,
): Promise<void> {
  await db.insert(t.auditEvents).values({
    id: ulid(),
    invoiceId: null,
    actorType: 'system',
    actorUserId: null,
    event,
    fromState: null,
    toState: null,
    detailJson: JSON.stringify(detail),
    createdAt: now,
  });
}
