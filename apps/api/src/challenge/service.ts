import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, lt, ne, or } from 'drizzle-orm';
import {
  CHALLENGE_MAX_INVOICES,
  CHALLENGE_MAX_RECORD_FILES,
  type ApiChallengeConfig,
  type ApiChallengeInvoice,
  type ApiChallengeStage,
  type ApiChallengeState,
  type ApiChallengeSummary,
  type ApiFinding,
  type ChallengeDetails,
  type ChallengeFollowUp,
  type ChallengeInterest,
} from '@veyra/shared';
import { validateGstin } from '@veyra/india-tax';
import { renderPdfPage, uprightImage } from '@veyra/extractor';
import type { CommercialAdmin, CommercialContext } from '../commercial/admin';
import type { VeyraDb } from '../db/open';
import * as t from '../db/schema';
import { ulid } from '../ids';
import { templateFiles } from '../imports/templates';
import { VeyraError } from '../workflow/veyra';
import type { EmailSender } from './email';
import { challengeEmail } from './email';
import { renderChallengeReport } from './report';
import {
  looksLikeRegister,
  registerRowsFromJson,
  registerRowsFromSheet,
  registerToReceipts,
} from './register';
import { ReceiptFileSchema } from '../workflow/erp-receipts';
import { readCsv } from '../spreadsheet/csv';
import { readXlsx, SpreadsheetError } from '../spreadsheet/xlsx';
import type { ChallengeWorkspace, ChallengeWorkspaces } from './workspaces';

/**
 * The 5 Invoice Challenge. A prospect agrees to how their invoices are processed, uploads up to
 * five real supplier invoices and, optionally, the purchasing records to check them against; the product's own
 * pipeline checks them in the challenge's isolated workspace (./workspaces.ts) and the results,
 * the evidence and the report are built from what that pipeline recorded. Nothing here decides
 * whether an invoice is right: it only reads the engine's outcome and says it plainly.
 *
 * Access is by a secret token (sent as a header, never in a URL path; only its hash is stored).
 *
 * One challenge per browser (the routes) and per work e-mail (here). Once the full results are
 * shown, the invoices and their readings are kept `resultsHours` more and then deleted; the
 * numbers stay, and the report goes by e-mail as a PDF.
 *
 * The prospect's details (company, work e-mail) are asked only after the checks, beside the
 * headline result. Until they are given, the server sends the numbers only: no finding, evidence
 * or report leaves it. In the table, "not given yet" is an empty company name and e-mail.
 */
type Challenge = typeof t.challenges.$inferSelect;
type InvoiceRow = typeof t.invoices.$inferSelect;

export interface ChallengeServiceOptions {
  db: VeyraDb;
  workspaces: ChallengeWorkspaces;
  commercial: CommercialAdmin;
  email: EmailSender;
  clock?: () => Date;
  /** Days a challenge's documents and readings are kept (then deleted; the summary stays). */
  retentionDays?: number;
  /** New challenges per UTC day, across all prospects (cost and abuse control). */
  dailyLimit?: number;
  /** Hours the invoices are kept after the full results are shown (then deleted). */
  resultsHours?: number;
  /** New challenges per internet address per UTC day (one person cannot use up the day). */
  perAddressLimit?: number;
  /** The reading service named to prospects ("Google Gemini"), or null: local reading only. */
  aiProvider: string | null;
  /** Where links in e-mails point (https://challenge.veyrafy.com). */
  publicOrigin: string | null;
  /** "Book a walkthrough" opens this, when set. */
  bookingUrl: string | null;
  /** The Veyrafy team is told here when a challenge completes or asks for a walkthrough. */
  notifyEmail: string | null;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

const STAGE_LABEL: Record<ApiChallengeStage['key'], string> = {
  read: 'Reading invoice details',
  calculations: 'Checking calculations',
  duplicates: 'Checking duplicate patterns',
  records: 'Matching purchasing records',
  quantities: 'Checking quantities',
  tax: 'Checking tax',
  exceptions: 'Identifying exceptions',
};
/** The engine's rules behind each step (shared/src/rules.ts). */
const STAGE_RULES: Partial<Record<ApiChallengeStage['key'], readonly string[]>> = {
  calculations: ['R06', 'R09', 'R10'],
  duplicates: ['R11'],
  records: ['R12', 'R14', 'R17'],
  quantities: ['R23', 'R26'],
  tax: ['R07', 'R08'],
};
/**
 * Open points that only say a record is not there to compare with (supplier, item, order or
 * receipt not found). When the prospect provided no records at all, they mean "not checked
 * against records", not a problem with the invoice.
 */
const RECORD_GAP = new Set([
  'VF_R17',
  'VF_R20',
  'CA_VENDOR',
  'CA_ITEM',
  'AM_ITEM',
  'CA_PO',
  'AM_OPEN_PO',
  'AM_PO_LINE',
  'CA_GRN',
]);
const WORKING = ['UPLOADED', 'EXTRACTING', 'MATCHING', 'RESOLVING', 'VALIDATING', 'COMMITTING'];
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DAY_MS = 86_400_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** The report's file name. */
export const reportName = (company: string): string =>
  `Veyrafy-Invoice-Verification-Report-${(company || 'Report').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60)}.pdf`;
/** Whether the prospect has given their details (the full results are open). */
export const detailsGiven = (ch: { email: string }): boolean => ch.email !== '';
/** The company as shown to the Veyrafy team and in the workspace before the details are given. */
const companyOf = (ch: { companyName: string }) => ch.companyName || 'Your company';

interface RecordsState {
  files: {
    name: string;
    kind: 'template' | 'receipts' | 'register';
    at: string;
    summary: string;
  }[];
  counts: Record<string, number>;
}

export class ChallengeService {
  readonly #o: ChallengeServiceOptions & {
    clock: () => Date;
    retentionDays: number;
    dailyLimit: number;
    resultsHours: number;
    perAddressLimit: number;
  };
  /** Challenges started today per address (hashed; kept in memory only, for the day). */
  #byAddress = { day: '', counts: new Map<string, number>() };
  /** The day the team was last told the daily cap was reached (once a day). */
  #capAlerted = '';
  #ticker: NodeJS.Timeout | null = null;

  constructor(options: ChallengeServiceOptions) {
    this.#o = {
      clock: () => new Date(),
      retentionDays: 30,
      dailyLimit: 20,
      resultsHours: 24,
      perAddressLimit: 3,
      ...options,
    };
  }

  get workspaces(): ChallengeWorkspaces {
    return this.#o.workspaces;
  }

  private now(): string {
    return this.#o.clock().toISOString();
  }

  config(): ApiChallengeConfig {
    return {
      enabled: true,
      maxInvoices: CHALLENGE_MAX_INVOICES,
      aiProvider: this.#o.aiProvider,
      retentionDays: this.#o.retentionDays,
      resultsHours: this.#o.resultsHours,
      templates: templateFiles(),
    };
  }

  // ── Starting, and finding a challenge by its token ───────────────────────

  /** Starts a challenge on the prospect's consent alone (details come after the results). */
  async create(address?: string): Promise<{ token: string; challenge: Challenge }> {
    const now = this.#o.clock();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayKey = day.toISOString().slice(0, 10);
    if (this.#byAddress.day !== dayKey) this.#byAddress = { day: dayKey, counts: new Map() };
    const who = address ? sha256(`${dayKey}|${address}`) : null;
    if (who && (this.#byAddress.counts.get(who) ?? 0) >= this.#o.perAddressLimit)
      throw new VeyraError(
        'RATE_LIMITED',
        'Too many challenges have been started from this connection today. Please try again tomorrow, or contact Veyrafy.',
      );
    const today = await this.#o.db
      .select({ id: t.challenges.id })
      .from(t.challenges)
      .where(gte(t.challenges.createdAt, day.toISOString()))
      .limit(this.#o.dailyLimit);
    if (today.length >= this.#o.dailyLimit) {
      if (this.#capAlerted !== dayKey) {
        this.#capAlerted = dayKey;
        this.#o.log?.warn({ dailyLimit: this.#o.dailyLimit }, 'challenge daily cap reached');
        if (this.#o.notifyEmail)
          await this.#o.email.send({
            to: this.#o.notifyEmail,
            subject: '5 Invoice Challenge: today’s limit reached',
            text: `The ${this.#o.dailyLimit} challenges allowed today have all been started; new prospects are asked to come back tomorrow. To allow more, raise VEYRA_CHALLENGE_DAILY_LIMIT on the challenge service. See the Control Centre for today's challenges.`,
          });
      }
      throw new VeyraError(
        'RATE_LIMITED',
        'The challenge is fully booked for today. Please try again tomorrow, or contact Veyrafy.',
      );
    }
    if (who) this.#byAddress.counts.set(who, (this.#byAddress.counts.get(who) ?? 0) + 1);
    const token = randomBytes(32).toString('base64url');
    const iso = now.toISOString();
    const [row] = await this.#o.db
      .insert(t.challenges)
      .values({
        id: ulid(),
        tokenHash: sha256(token),
        status: 'collecting',
        companyName: '',
        email: '',
        consentAt: iso,
        aiProvider: this.#o.aiProvider,
        expiresAt: new Date(now.getTime() + this.#o.retentionDays * DAY_MS).toISOString(),
        createdAt: iso,
        updatedAt: iso,
      })
      .returning();
    if (!row) throw new Error('challenge not created');
    this.#o.log?.info({ challengeId: row.id }, 'challenge started');
    return { token, challenge: row };
  }

  /**
   * Who the report is for. Opens the full results; when the checks are already complete, the
   * report e-mail goes now (otherwise when they complete). Can be corrected later.
   */
  async giveDetails(ch: Challenge, details: ChallengeDetails): Promise<void> {
    this.live(ch);
    // One challenge per work e-mail: another challenge already holds it.
    const taken = await this.#o.db
      .select({ id: t.challenges.id })
      .from(t.challenges)
      .where(and(eq(t.challenges.email, details.email), ne(t.challenges.id, ch.id)))
      .limit(1);
    if (taken.length)
      throw new VeyraError(
        'CONFLICT',
        'This work e-mail has already been used for the 5 Invoice Challenge, and its report was sent to it. To check more invoices, book a walkthrough with Veyrafy.',
        { field: 'email' },
      );
    const first = !detailsGiven(ch);
    await this.update(ch.id, {
      companyName: details.companyName,
      contactName: details.contactName || null,
      email: details.email,
      phone: details.phone || null,
      outlets: details.outlets ?? null,
      erpSystem: details.erpSystem || null,
    });
    this.#o.log?.info({ challengeId: ch.id }, 'challenge details given');
    const now = await this.fresh(ch.id);
    if (now.status === 'complete' && (first || now.emailStatus !== 'sent'))
      await this.completed(now, (await this.state(now)).summary);
  }

  async byToken(token: string | undefined): Promise<Challenge> {
    if (!token || !TOKEN.test(token))
      throw new VeyraError('NOT_FOUND', 'This challenge link is not valid.');
    const row = (
      await this.#o.db
        .select()
        .from(t.challenges)
        .where(
          or(
            eq(t.challenges.tokenHash, sha256(token)),
            eq(t.challenges.linkTokenHash, sha256(token)),
          ),
        )
        .limit(1)
    )[0];
    if (!row) throw new VeyraError('NOT_FOUND', 'This challenge link is not valid.');
    return row;
  }

  private async fresh(id: string): Promise<Challenge> {
    const row = (
      await this.#o.db.select().from(t.challenges).where(eq(t.challenges.id, id)).limit(1)
    )[0];
    if (!row) throw new VeyraError('NOT_FOUND', 'Challenge not found.');
    return row;
  }

  private async update(id: string, patch: Partial<Challenge>): Promise<void> {
    await this.#o.db
      .update(t.challenges)
      .set({ ...patch, updatedAt: this.now() })
      .where(eq(t.challenges.id, id));
  }

  private live(ch: Challenge): void {
    if (ch.status === 'purged')
      throw new VeyraError(
        'INVALID_STATE',
        `This challenge has ended: its invoices were deleted after ${this.#o.retentionDays} days.`,
      );
  }

  private async workspace(ch: Challenge): Promise<ChallengeWorkspace> {
    this.live(ch);
    const ws = await this.#o.workspaces.open(ch.id, {
      company: companyOf(ch),
      held: ch.status === 'collecting',
    });
    ws.held = ch.status === 'collecting';
    return ws;
  }

  // ── Invoices ─────────────────────────────────────────────────────────────

  private async activeInvoices(ws: ChallengeWorkspace) {
    return ws.veyra.db
      .select()
      .from(t.invoices)
      .innerJoin(t.documents, eq(t.documents.id, t.invoices.documentId))
      .where(ne(t.invoices.state, 'REJECTED'))
      .orderBy(asc(t.invoices.seq));
  }

  async uploadInvoice(ch: Challenge, file: { filename: string; bytes: Uint8Array }) {
    const ws = await this.workspace(ch);
    if ((await this.activeInvoices(ws)).length >= CHALLENGE_MAX_INVOICES)
      throw new VeyraError(
        'LIMIT_REACHED',
        `The challenge takes ${CHALLENGE_MAX_INVOICES} invoices. Remove one to add another.`,
      );
    // The product's own upload: type decided by the bytes, size and page limits, duplicates.
    const created = await ws.veyra.upload(file, await ws.veyra.designatedUserId());
    // An invoice added after the checks started is checked like the others.
    if (ch.status === 'complete')
      await this.update(ch.id, { status: 'checking', completedAt: null });
    return created;
  }

  /** Takes an invoice out of the challenge (it stays recorded as removed, through the workflow). */
  async removeInvoice(ch: Challenge, invoiceId: string): Promise<void> {
    const ws = await this.workspace(ch);
    const inv = await this.invoiceOf(ws, invoiceId);
    const user = await ws.veyra.designatedUserId();
    if (inv.state === 'MATCHING' && ws.held) {
      await ws.veyra.db.transaction(async (tx) => {
        await ws.veyra.transition(
          tx,
          inv.id,
          'MATCHING',
          'FAILED',
          { type: 'user', userId: user },
          { failedStage: 'MATCHING', failureReason: 'Removed from the challenge.' },
        );
      });
    } else if (inv.state !== 'FAILED' && !(inv.state === 'NEEDS_INPUT' && ws.held))
      throw new VeyraError(
        'INVALID_STATE',
        'An invoice can be removed before the checks start, or when it could not be processed.',
      );
    await ws.veyra.reject(inv.id, 'Removed from the challenge', user);
  }

  /** Processes an invoice that failed again, from where it is safe (never deletes anything). */
  async retryInvoice(ch: Challenge, invoiceId: string): Promise<void> {
    const ws = await this.workspace(ch);
    await this.invoiceOf(ws, invoiceId);
    await ws.veyra.retryForOperations(invoiceId);
  }

  private async invoiceOf(ws: ChallengeWorkspace, invoiceId: string): Promise<InvoiceRow> {
    const inv = (
      await ws.veyra.db.select().from(t.invoices).where(eq(t.invoices.id, invoiceId)).limit(1)
    )[0];
    if (!inv || inv.state === 'REJECTED') throw new VeyraError('NOT_FOUND', 'Invoice not found.');
    return inv;
  }

  /** One page of an uploaded invoice, as the product's viewer shows it (same rendering). */
  async page(ch: Challenge, documentId: string, page: number) {
    const ws = await this.workspace(ch);
    const d = (
      await ws.veyra.db.select().from(t.documents).where(eq(t.documents.id, documentId)).limit(1)
    )[0];
    if (!d || d.status === 'DELETED') throw new VeyraError('NOT_FOUND', 'Document not found.');
    const bytes = await ws.veyra.readDocument(d);
    if (d.mime === 'application/pdf') {
      const drawn = await renderPdfPage(bytes, page);
      if (!drawn) throw new VeyraError('NOT_FOUND', 'The document has no such page.');
      return { mime: 'image/png', body: Buffer.from(drawn.png) };
    }
    if (page !== 1) throw new VeyraError('NOT_FOUND', 'The document has no such page.');
    if (d.mime !== 'image/png' && d.mime !== 'image/jpeg')
      throw new VeyraError('NOT_FOUND', 'The document cannot be shown.');
    return {
      mime: d.mime,
      body: Buffer.from((await uprightImage(Buffer.from(bytes), d.mime)).bytes),
    };
  }

  // ── Records ──────────────────────────────────────────────────────────────

  /**
   * Adds the prospect's records: a Veyrafy template workbook or CSV (suppliers, items, purchase
   * orders, goods receipts), or an ERP goods-receipt export (JSON). Through the product's own
   * import validation; nothing is guessed from other formats.
   */
  async addRecords(ch: Challenge, file: { filename: string; bytes: Uint8Array }) {
    if (ch.status !== 'collecting')
      throw new VeyraError('INVALID_STATE', 'Records can be added before the checks start.');
    const records = JSON.parse(ch.recordsJson) as Partial<RecordsState>;
    const state: RecordsState = { files: records.files ?? [], counts: records.counts ?? {} };
    if (state.files.length >= CHALLENGE_MAX_RECORD_FILES)
      throw new VeyraError(
        'LIMIT_REACHED',
        `Up to ${CHALLENGE_MAX_RECORD_FILES} record files can be added to a challenge.`,
      );
    const ws = await this.workspace(ch);
    const user = await ws.veyra.designatedUserId();
    const name = file.filename.slice(0, 200);
    const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
    let summary: string;
    let kind: 'template' | 'receipts' | 'register';
    /** The business's own record of these invoices, compared value by value. */
    const fromRegister = async (rows: ReturnType<typeof registerRowsFromSheet>) => {
      const r = await ws.veyra.importReceipts(name, registerToReceipts(rows, name), user);
      const lines = rows.filter((x) => Object.keys(x).length > 0).length;
      state.counts.register = (state.counts.register ?? 0) + r.records.length;
      return `${r.records.length} invoice${r.records.length === 1 ? '' : 's'} from your system (${lines} line${lines === 1 ? '' : 's'})`;
    };
    const sheet = ext === 'xlsx' || ext === 'csv' ? readSheetRows(file.bytes, ext, name) : null;
    if (ext === 'json') {
      let json: unknown;
      try {
        json = JSON.parse(Buffer.from(file.bytes).toString('utf8'));
      } catch {
        throw new VeyraError('INVALID_INPUT', 'This JSON file could not be read.');
      }
      const register = ReceiptFileSchema.safeParse(json).success
        ? null
        : registerRowsFromJson(json);
      if (register) {
        kind = 'register';
        summary = await fromRegister(register);
      } else {
        const r = await ws.veyra.importReceipts(name, json, user);
        const n = r.records.length;
        kind = 'receipts';
        summary = `${n} goods receipt${n === 1 ? '' : 's'}`;
        state.counts.receipts = (state.counts.receipts ?? 0) + r.imported;
      }
    } else if (sheet && looksLikeRegister(sheet[0]?.cells.map((c) => c.text) ?? [])) {
      kind = 'register';
      summary = await fromRegister(registerRowsFromSheet(sheet));
    } else if (ext === 'xlsx' || ext === 'csv') {
      const check = await ws.imports.check([{ filename: name, bytes: file.bytes }], user);
      if (check.status === 'invalid' || !check.canConfirm) {
        const first = check.errors.slice(0, 3).map((e) => e.message);
        throw new VeyraError(
          'INVALID_INPUT',
          first.length
            ? `This file could not be used: ${first.join(' ')}`
            : 'This file has no records Veyrafy can use. Use the template columns.',
          { problems: check.errors.slice(0, 20) },
        );
      }
      const done = await ws.imports.confirm(check.id, user);
      const c = done.result?.created ?? { vendors: 0, items: 0, purchaseOrders: 0, grns: 0 };
      kind = 'template';
      const parts = [
        [c.vendors, 'supplier'],
        [c.items, 'item'],
        [c.purchaseOrders, 'purchase order'],
        [c.grns, 'goods receipt'],
      ]
        .filter(([n]) => (n as number) > 0)
        .map(([n, w]) => `${n as number} ${w as string}${n === 1 ? '' : 's'}`);
      summary = parts.length ? parts.join(', ') : 'No new records (already added)';
      for (const [k, n] of Object.entries(c)) state.counts[k] = (state.counts[k] ?? 0) + n;
    } else {
      throw new VeyraError(
        'INVALID_INPUT',
        'Use an Excel, CSV or JSON export from your system (your purchase register or bills, one row per invoice line), or Veyrafy’s template. PDF orders and receipts are not read as records.',
      );
    }
    state.files.push({ name, kind, at: this.now(), summary });
    await this.update(ch.id, {
      recordFiles: state.files.length,
      recordsJson: JSON.stringify(state),
    });
  }

  // ── Running the checks ───────────────────────────────────────────────────

  /**
   * Starts the checks: the buyer GSTIN the prospect confirms becomes the company the invoices
   * must be billed to, and every invoice read so far goes on to the checks.
   */
  async startChecks(ch: Challenge, gstinInput: string): Promise<void> {
    if (ch.status !== 'collecting')
      throw new VeyraError('INVALID_STATE', 'The checks have already started.');
    const g = validateGstin(gstinInput.trim().toUpperCase());
    if (!g.ok) throw new VeyraError('INVALID_INPUT', 'Enter a valid GSTIN.', { field: 'gstin' });
    const ws = await this.workspace(ch);
    if ((await this.activeInvoices(ws)).length === 0)
      throw new VeyraError('INVALID_STATE', 'Upload at least one invoice first.');
    ws.erp.setCompany({ name: companyOf(ch), gstin: g.value.gstin });
    await this.update(ch.id, {
      status: 'checking',
      gstin: g.value.gstin,
      checksStartedAt: this.now(),
    });
    ws.held = false;
    await ws.veyra.releaseHeld();
    this.#o.log?.info({ challengeId: ch.id }, 'challenge checks started');
  }

  // ── What the prospect sees ───────────────────────────────────────────────

  async state(ch: Challenge): Promise<ApiChallengeState> {
    const records = JSON.parse(ch.recordsJson) as Partial<RecordsState>;
    const base = {
      id: ch.id,
      status: ch.status as ApiChallengeState['status'],
      companyName: ch.companyName || null,
      email: ch.email || null,
      unlocked: detailsGiven(ch),
      gstin: ch.gstin,
      aiProvider: ch.aiProvider,
      maxInvoices: CHALLENGE_MAX_INVOICES,
      records: { files: records.files ?? [], counts: records.counts ?? {} },
      checksStartedAt: ch.checksStartedAt,
      completedAt: ch.completedAt,
      expiresAt: ch.expiresAt,
      emailStatus: ch.emailStatus as ApiChallengeState['emailStatus'],
      interest: ch.interest as ChallengeInterest,
      bookingUrl: this.#o.bookingUrl,
    };
    if (ch.status === 'purged')
      return { ...base, gstinCandidates: [], invoices: [], summary: this.storedSummary(ch) };
    const ws = await this.workspace(ch);
    const all = await this.invoiceViews(ws, ch);
    // Before the details are given, no finding leaves the server: the numbers only.
    const invoices = detailsGiven(ch) ? all : all.map((i) => ({ ...i, finding: null, more: [] }));
    const summary =
      ch.status === 'collecting' ? null : summarize(all.filter((i) => i.phase !== 'reading'));
    const gstinCandidates = await this.gstinCandidates(ws);
    // Counters for the Veyrafy team (Control Centre), and completion.
    const processed = all.filter((i) => i.phase === 'done' || i.phase === 'read').length;
    const failed = all.filter((i) => i.outcome === 'failed').length;
    const patch: Partial<Challenge> = {};
    if (ch.invoicesSubmitted !== invoices.length) patch.invoicesSubmitted = invoices.length;
    if (ch.invoicesProcessed !== processed) patch.invoicesProcessed = processed;
    if (ch.invoicesFailed !== failed) patch.invoicesFailed = failed;
    let completed = ch;
    if (
      ch.status === 'checking' &&
      invoices.length > 0 &&
      invoices.every((i) => i.outcome !== 'processing') &&
      summary
    ) {
      const at = this.now();
      Object.assign(patch, {
        status: 'complete',
        completedAt: at,
        cleared: summary.cleared,
        attention: summary.attention,
        totalInvoicePaise: summary.totalPaise,
        reviewValuePaise: summary.reviewValuePaise,
        findingsJson: JSON.stringify(summary.byType),
      } satisfies Partial<Challenge>);
      completed = { ...ch, ...patch } as Challenge;
    }
    if (Object.keys(patch).length) await this.update(ch.id, patch);
    if (completed !== ch) await this.completed(completed, summary);
    return {
      ...base,
      status: completed.status as ApiChallengeState['status'],
      completedAt: completed.completedAt,
      emailStatus: (await this.fresh(ch.id)).emailStatus as ApiChallengeState['emailStatus'],
      gstinCandidates,
      invoices,
      summary,
    };
  }

  private storedSummary(ch: Challenge): ApiChallengeSummary | null {
    if (!ch.completedAt) return null;
    return {
      checked: ch.cleared + ch.attention,
      totalPaise: ch.totalInvoicePaise ?? 0,
      totalUnread: 0,
      cleared: ch.cleared,
      clearedAgainstRecords: 0,
      clearedInvoiceOnly: 0,
      review: 0,
      confirm: 0,
      failed: ch.invoicesFailed,
      attention: ch.attention,
      reviewValuePaise: ch.reviewValuePaise ?? 0,
      byType: JSON.parse(ch.findingsJson) as Record<string, number>,
    };
  }

  private async gstinCandidates(ws: ChallengeWorkspace) {
    const rows = await ws.veyra.db
      .select({ invoiceId: t.extractedFields.invoiceId, value: t.extractedFields.valueJson })
      .from(t.extractedFields)
      .innerJoin(t.invoices, eq(t.invoices.id, t.extractedFields.invoiceId))
      .where(
        and(eq(t.extractedFields.path, 'header.buyerGstin'), ne(t.invoices.state, 'REJECTED')),
      );
    const counts = new Map<string, number>();
    for (const r of rows) {
      const v = JSON.parse(r.value) as unknown;
      if (typeof v !== 'string') continue;
      const g = validateGstin(v);
      if (g.ok) counts.set(g.value.gstin, (counts.get(g.value.gstin) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([gstin, invoices]) => ({ gstin, invoices }));
  }

  /** Every invoice of the challenge, with its steps and result, from the engine's records. */
  private async invoiceViews(
    ws: ChallengeWorkspace,
    ch: Challenge,
  ): Promise<ApiChallengeInvoice[]> {
    const rows = await this.activeInvoices(ws);
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.invoices.id);
    const db = ws.veyra.db;
    const [summaries, rules, receipts, matches, questions] = await Promise.all([
      ws.presenter.summaries(rows),
      db.select().from(t.validationResults).where(inArray(t.validationResults.invoiceId, ids)),
      db
        .select({ invoiceId: t.auditEvents.invoiceId })
        .from(t.auditEvents)
        .where(
          and(inArray(t.auditEvents.invoiceId, ids), eq(t.auditEvents.event, 'receipt.checked')),
        ),
      db
        .select()
        .from(t.matchResults)
        .where(and(inArray(t.matchResults.invoiceId, ids), eq(t.matchResults.outcome, 'found'))),
      db
        .select({
          invoiceId: t.questions.invoiceId,
          code: t.questions.code,
          prompt: t.questions.prompt,
        })
        .from(t.questions)
        .where(and(inArray(t.questions.invoiceId, ids), eq(t.questions.status, 'open')))
        .orderBy(asc(t.questions.seq)),
    ]);
    const hasRecords = ch.recordFiles > 0;
    const out: ApiChallengeInvoice[] = [];
    for (const [i, { invoices: inv, documents: doc }] of rows.entries()) {
      const s = summaries[i];
      const latest = new Map<string, string>();
      for (const r of rules)
        if (r.invoiceId === inv.id && r.runNo === inv.runNo) {
          // A rule can have one result per line: a failure on any line wins.
          if (latest.get(r.ruleCode) !== 'fail') latest.set(r.ruleCode, r.outcome);
        }
      const receiptChecked = receipts.some((r) => r.invoiceId === inv.id);
      const found = new Set(
        matches.filter((m) => m.invoiceId === inv.id && m.runNo === inv.runNo).map((m) => m.entity),
      );
      const open = questions.filter((q) => q.invoiceId === inv.id);
      const finding = inv.state === 'NEEDS_INPUT' ? await ws.presenter.finding(inv) : null;
      const view = classify({
        inv,
        held: ws.held,
        finding,
        openCodes: open.map((q) => q.code),
        receiptChecked,
        matchedRecords: receiptChecked || (found.has('vendor') && found.has('po')),
        hasRecords,
      });
      out.push({
        id: inv.id,
        documentId: doc.id,
        filename: doc.filename,
        isPdf: doc.mime === 'application/pdf',
        supplier: s?.supplierName ?? null,
        number: s?.number ?? null,
        invoiceDate: s?.invoiceDate ?? null,
        totalPaise: s?.totalPaise ?? null,
        phase: view.phase,
        outcome: view.outcome,
        basis: view.basis,
        stages: stagesOf(
          inv,
          ws.held,
          latest,
          receiptChecked,
          hasRecords,
          // A difference from the system's record is a finding too, without a question.
          view.outcome === 'review' || view.outcome === 'confirm' ? Math.max(1, open.length) : 0,
        ),
        finding: view.outcome === 'review' || view.outcome === 'confirm' ? finding : null,
        more:
          view.outcome === 'review' || view.outcome === 'confirm'
            ? open.slice(1).map((q) => q.prompt)
            : [],
        failure:
          inv.state === 'FAILED'
            ? {
                reason: inv.failureReason ?? 'The invoice could not be processed.',
                stage: inv.failedStage,
              }
            : null,
        canRemove:
          inv.state === 'FAILED' ||
          (ws.held && inv.state !== 'EXTRACTING' && inv.state !== 'UPLOADED'),
        canRetry: inv.state === 'FAILED' && doc.status !== 'DELETED',
      });
    }
    return out;
  }

  // ── Completion: report, e-mail ───────────────────────────────────────────

  /** A fresh secret link to the results (in the URL fragment: never sent to a server or logged). */
  private async reportLink(id: string): Promise<string | null> {
    if (!this.#o.publicOrigin) return null;
    const token = randomBytes(32).toString('base64url');
    await this.update(id, { linkTokenHash: sha256(token) });
    return `${this.#o.publicOrigin}/5-invoice-challenge#access=${token}`;
  }

  private async completed(ch: Challenge, summary: ApiChallengeSummary | null): Promise<void> {
    this.#o.log?.info({ challengeId: ch.id }, 'challenge complete');
    // Results not shown yet (no details): nothing to send, nothing to delete yet.
    if (!summary || !detailsGiven(ch)) return;
    // The session is over once the full results are shown: the invoices go after a while.
    const closeAt = new Date(this.#o.clock().getTime() + this.#o.resultsHours * 3_600_000);
    if (closeAt.toISOString() < ch.expiresAt)
      await this.update(ch.id, { expiresAt: closeAt.toISOString() });
    if (ch.emailStatus === 'sent') return;
    const mail = challengeEmail({
      company: ch.companyName,
      contactName: ch.contactName,
      summary,
      link: await this.reportLink(ch.id),
      linkHours: this.#o.resultsHours,
      bookingUrl: this.#o.bookingUrl,
    });
    const pdf = await this.pdf(await this.fresh(ch.id));
    const result = await this.#o.email.send({
      to: ch.email,
      ...mail,
      attachments: [{ filename: reportName(ch.companyName), content: pdf }],
    });
    await this.update(ch.id, {
      emailStatus: result,
      ...(result === 'sent' ? { emailSentAt: this.now() } : {}),
    });
    if (this.#o.notifyEmail)
      await this.#o.email.send({
        to: this.#o.notifyEmail,
        subject: `5 Invoice Challenge completed: ${ch.companyName}`,
        text: `${ch.companyName} (${ch.email}) completed the 5 Invoice Challenge: ${summary.checked} checked, ${summary.attention} need attention. See the Control Centre.`,
      });
  }

  async report(ch: Challenge): Promise<Buffer> {
    if (!detailsGiven(ch))
      throw new VeyraError('FORBIDDEN', 'Tell us who the report is for to open it.');
    if (ch.status === 'purged')
      throw new VeyraError(
        'INVALID_STATE',
        'Your invoices have been deleted, as agreed. The report was e-mailed to you as a PDF.',
      );
    if (ch.status !== 'complete')
      throw new VeyraError('INVALID_STATE', 'The report is ready once every invoice is checked.');
    const pdf = await this.pdf(ch);
    const at = this.now();
    await this.update(ch.id, {
      reportGeneratedAt: ch.reportGeneratedAt ?? at,
      reportDownloads: ch.reportDownloads + 1,
      reportDownloadedAt: at,
    });
    return pdf;
  }

  /** The report PDF, from the challenge's results as they stand. */
  private async pdf(ch: Challenge): Promise<Buffer> {
    const state = await this.state(ch);
    if (!state.summary) throw new VeyraError('INVALID_STATE', 'The report is not ready.');
    return renderChallengeReport({
      company: companyOf(ch),
      gstin: ch.gstin,
      date: this.#o.clock(),
      summary: state.summary,
      invoices: state.invoices,
      records: state.records.files,
      challengeId: ch.id,
    });
  }

  async interest(ch: Challenge, kind: 'walkthrough' | 'pilot'): Promise<void> {
    if (!detailsGiven(ch))
      throw new VeyraError('FORBIDDEN', 'Tell us who the report is for first.');
    await this.update(ch.id, { interest: kind, interestAt: this.now() });
    if (this.#o.notifyEmail)
      await this.#o.email.send({
        to: this.#o.notifyEmail,
        subject: `${kind === 'pilot' ? 'Pilot' : 'Walkthrough'} requested: ${ch.companyName}`,
        text: `${ch.companyName} asked for a ${kind === 'pilot' ? 'pilot' : '15-minute walkthrough'} after the 5 Invoice Challenge.\nContact: ${ch.contactName ?? '(no name)'} · ${ch.email}${ch.phone ? ` · ${ch.phone}` : ''}`,
      });
  }

  // ── The Veyrafy team (Control Centre) ────────────────────────────────────

  async list(limit = 200) {
    const rows = await this.#o.db
      .select()
      .from(t.challenges)
      .orderBy(desc(t.challenges.seq))
      .limit(Math.min(limit, 500));
    // The token hash never leaves the server.
    const SECRET = new Set(['tokenHash', 'linkTokenHash']);
    return rows.map((r) => ({
      ...(Object.fromEntries(Object.entries(r).filter(([k]) => !SECRET.has(k))) as Omit<
        Challenge,
        'tokenHash' | 'linkTokenHash'
      >),
      records: JSON.parse(r.recordsJson) as unknown,
      findings: JSON.parse(r.findingsJson) as Record<string, number>,
    }));
  }

  async setFollowUp(
    id: string,
    followUp: ChallengeFollowUp,
    reason: string,
    ctx: CommercialContext,
  ): Promise<void> {
    const ch = await this.fresh(id);
    if (ch.followUp === followUp) throw new VeyraError('INVALID_STATE', 'Already set.');
    const why = reason.trim();
    if (!why) throw new VeyraError('INVALID_INPUT', 'Give a reason for this change.');
    await this.#o.db.transaction(async (tx) => {
      await tx
        .update(t.challenges)
        .set({ followUp, updatedAt: this.now() })
        .where(eq(t.challenges.id, id));
      await this.#o.commercial.event(
        tx as unknown as VeyraDb,
        'challenge.follow_up_changed',
        {
          subject: `challenge:${id}`,
          oldValue: ch.followUp,
          newValue: followUp,
          reason: why.slice(0, 500),
        },
        ctx,
      );
    });
  }

  // ── Background: completion and retention ─────────────────────────────────

  /** Finishes challenges whose checks completed while nobody was looking; deletes expired ones. */
  async tick(): Promise<void> {
    const now = this.now();
    const expired = await this.#o.db
      .select()
      .from(t.challenges)
      .where(and(ne(t.challenges.status, 'purged'), lt(t.challenges.expiresAt, now)));
    for (const ch of expired) {
      await this.#o.workspaces.remove(ch.id);
      await this.update(ch.id, { status: 'purged', purgedAt: now });
      this.#o.log?.info({ challengeId: ch.id }, 'challenge documents deleted (retention)');
    }
    const checking = await this.#o.db
      .select()
      .from(t.challenges)
      .where(eq(t.challenges.status, 'checking'));
    for (const ch of checking) {
      if (!this.#o.workspaces.exists(ch.id)) continue;
      await this.state(ch).catch((e: unknown) =>
        this.#o.log?.warn({ challengeId: ch.id, err: String(e) }, 'challenge check failed'),
      );
    }
  }

  start(intervalMs = 30_000): void {
    if (this.#ticker) return;
    this.#o.workspaces.start();
    // Resume at once after a restart (queued checks continue), then periodically.
    void this.tick().catch(() => undefined);
    this.#ticker = setInterval(() => void this.tick().catch(() => undefined), intervalMs);
    this.#ticker.unref();
  }

  async shutdown(graceMs = 5_000): Promise<void> {
    if (this.#ticker) clearInterval(this.#ticker);
    this.#ticker = null;
    await this.#o.workspaces.shutdown(graceMs);
  }
}

// ── The result of one invoice, from the engine's state ─────────────────────

function classify(i: {
  inv: InvoiceRow;
  held: boolean;
  finding: ApiFinding | null;
  openCodes: string[];
  receiptChecked: boolean;
  matchedRecords: boolean;
  hasRecords: boolean;
}): Pick<ApiChallengeInvoice, 'phase' | 'outcome' | 'basis'> {
  const s = i.inv.state;
  if (s === 'FAILED') return { phase: 'failed', outcome: 'failed', basis: null };
  if (s === 'UPLOADED' || s === 'EXTRACTING')
    return { phase: 'reading', outcome: 'processing', basis: null };
  if (s === 'MATCHING' && i.held) return { phase: 'read', outcome: 'processing', basis: null };
  if (WORKING.includes(s)) return { phase: 'checking', outcome: 'processing', basis: null };
  if (s === 'VERIFIED_PENDING_PAYMENT')
    return { phase: 'done', outcome: 'cleared', basis: i.matchedRecords ? 'records' : 'invoice' };
  // NEEDS_INPUT. With no records at all, "this record is not there" is not a problem with the
  // invoice: every check of the invoice itself passed (the engine checks it first).
  if (!i.hasRecords && i.openCodes.length > 0 && i.openCodes.every((c) => RECORD_GAP.has(c)))
    return { phase: 'done', outcome: 'cleared', basis: 'invoice' };
  return {
    phase: 'done',
    outcome: i.finding?.state === 'confirm' ? 'confirm' : 'review',
    basis: null,
  };
}

/** The steps of the checks for one invoice, from what the engine recorded. */
function stagesOf(
  inv: InvoiceRow,
  held: boolean,
  rules: Map<string, string>,
  receiptChecked: boolean,
  hasRecords: boolean,
  openCount: number,
): ApiChallengeStage[] {
  const st = (
    key: ApiChallengeStage['key'],
    status: ApiChallengeStage['status'],
    note: string | null = null,
  ): ApiChallengeStage => ({ key, label: STAGE_LABEL[key], status, note });
  const s = inv.state;
  const readFailed =
    s === 'FAILED' && (inv.failedStage === 'EXTRACTING' || inv.failedStage === 'UPLOADED');
  const read: ApiChallengeStage =
    s === 'UPLOADED'
      ? st('read', 'waiting')
      : s === 'EXTRACTING'
        ? st('read', 'running')
        : readFailed
          ? st('read', 'failed', inv.failureReason)
          : st('read', 'done');
  const rest = [
    'calculations',
    'duplicates',
    'records',
    'quantities',
    'tax',
    'exceptions',
  ] as const;
  if (read.status !== 'done')
    return [
      read,
      ...rest.map((k) =>
        st(
          k,
          readFailed ? 'skipped' : 'waiting',
          readFailed ? 'The invoice could not be read.' : null,
        ),
      ),
    ];
  const evaluated =
    ['NEEDS_INPUT', 'VERIFIED_PENDING_PAYMENT', 'COMMITTING'].includes(s) ||
    (s === 'FAILED' && inv.runNo > 0);
  if (!evaluated) {
    const status = held || s === 'FAILED' ? 'waiting' : 'running';
    return [
      read,
      ...rest.map((k) =>
        st(k, s === 'FAILED' ? 'skipped' : status, s === 'FAILED' ? inv.failureReason : null),
      ),
    ];
  }
  if (receiptChecked)
    return [
      read,
      st('calculations', 'done'),
      st('duplicates', 'done'),
      st('records', 'done', 'Matched to your system’s record'),
      st('quantities', 'done', 'Against your system’s record'),
      st('tax', 'done'),
      st(
        'exceptions',
        'done',
        openCount
          ? `${openCount} point${openCount === 1 ? '' : 's'} found`
          : 'Nothing needs attention',
      ),
    ];
  const group = (key: ApiChallengeStage['key']): ApiChallengeStage => {
    // Nothing to match against: the engine looked and found no record, which is not a finding.
    if (!hasRecords && (key === 'records' || key === 'quantities'))
      return st(key, 'skipped', 'Not checked: no records provided');
    const codes = STAGE_RULES[key] ?? [];
    const outcomes = codes.map((c) => rules.get(c) ?? 'not_evaluated');
    if (outcomes.some((o) => o === 'fail')) return st(key, 'done', 'Difference found');
    if (outcomes.every((o) => o === 'not_evaluated'))
      return st(
        key,
        'skipped',
        key === 'records' || key === 'quantities'
          ? hasRecords
            ? 'Not checked: no matching record'
            : 'Not checked: no records provided'
          : 'Not checked: waiting on an earlier point',
      );
    if (outcomes.every((o) => o === 'not_applicable' || o === 'not_evaluated'))
      return st(key, 'skipped', 'Not applicable to this invoice');
    return st(key, 'done');
  };
  return [
    read,
    group('calculations'),
    group('duplicates'),
    group('records'),
    group('quantities'),
    group('tax'),
    st(
      'exceptions',
      'done',
      openCount === 0
        ? 'Nothing needs attention'
        : `${openCount} point${openCount === 1 ? '' : 's'} found`,
    ),
  ];
}

/** The challenge's numbers, from the invoices' results (never extrapolated). */
export function summarize(invoices: ApiChallengeInvoice[]): ApiChallengeSummary {
  const done = invoices.filter((i) => i.outcome !== 'processing' && i.outcome !== 'failed');
  const attention = done.filter((i) => i.outcome === 'review' || i.outcome === 'confirm');
  const cleared = done.filter((i) => i.outcome === 'cleared');
  const byType: Record<string, number> = {};
  for (const i of attention) {
    const type = i.finding?.type ?? 'other';
    byType[type] = (byType[type] ?? 0) + 1;
  }
  const total = (list: ApiChallengeInvoice[]) => list.reduce((s, i) => s + (i.totalPaise ?? 0), 0);
  return {
    checked: done.length,
    totalPaise: total(done),
    totalUnread: done.filter((i) => i.totalPaise === null).length,
    cleared: cleared.length,
    clearedAgainstRecords: cleared.filter((i) => i.basis === 'records').length,
    clearedInvoiceOnly: cleared.filter((i) => i.basis === 'invoice').length,
    review: attention.filter((i) => i.outcome === 'review').length,
    confirm: attention.filter((i) => i.outcome === 'confirm').length,
    failed: invoices.filter((i) => i.outcome === 'failed').length,
    attention: attention.length,
    reviewValuePaise: total(attention),
    byType,
  };
}

/** The first sheet's rows (Excel) or the rows (CSV), for recognising an invoice register. */
function readSheetRows(bytes: Uint8Array, ext: 'xlsx' | 'csv', name: string) {
  try {
    return ext === 'csv' ? readCsv(bytes, name) : (readXlsx(bytes).sheets[0]?.rows ?? []);
  } catch (e) {
    if (e instanceof SpreadsheetError) throw new VeyraError('INVALID_INPUT', e.message);
    throw e;
  }
}
