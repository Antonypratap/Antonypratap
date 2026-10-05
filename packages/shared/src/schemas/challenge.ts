import { z } from 'zod';
import {
  CHALLENGE_EMAIL_STATUSES,
  CHALLENGE_INTERESTS,
  CHALLENGE_OUTCOMES,
  CHALLENGE_STATUSES,
} from '../challenge';
import { ApiFindingSchema } from './api';

/** The 5 Invoice Challenge: what the prospect's browser and the report read. */

const int = z.number().int();

/**
 * Starting a challenge: only the agreement to how the invoices are processed and kept. Nothing
 * else is asked before the prospect has seen what Veyrafy finds.
 */
export const ChallengeStartSchema = z.object({ consent: z.literal(true) }).strict();
export type ChallengeStart = z.infer<typeof ChallengeStartSchema>;

/** Who the report is for: given after the headline result, to open the full results. */
export const ChallengeDetailsSchema = z
  .object({
    companyName: z.string().trim().min(2).max(120),
    contactName: z.string().trim().max(120).optional(),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid work email.'),
    phone: z
      .string()
      .trim()
      .max(20)
      .regex(/^[+\d][\d\s-]{6,19}$/, 'Enter a valid phone number.')
      .optional(),
    outlets: z.number().int().min(1).max(10_000).optional(),
    erpSystem: z.string().trim().max(80).optional(),
  })
  .strict();
export type ChallengeDetails = z.infer<typeof ChallengeDetailsSchema>;

/** One step of the checks, from what the engine actually recorded (never a timer). */
export const CHALLENGE_STAGES = [
  'read',
  'calculations',
  'duplicates',
  'records',
  'quantities',
  'tax',
  'exceptions',
] as const;
export type ChallengeStage = (typeof CHALLENGE_STAGES)[number];

export const ApiChallengeStageSchema = z.object({
  key: z.enum(CHALLENGE_STAGES),
  label: z.string(),
  /**
   * waiting: not started; running: in progress; done: completed; skipped: completed but not
   * applicable or not possible (the note says why); failed: could not be completed.
   */
  status: z.enum(['waiting', 'running', 'done', 'skipped', 'failed']),
  note: z.string().nullable(),
});
export type ApiChallengeStage = z.infer<typeof ApiChallengeStageSchema>;

export const ApiChallengeInvoiceSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  filename: z.string(),
  isPdf: z.boolean(),
  supplier: z.string().nullable(),
  number: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  totalPaise: int.nullable(),
  /** "read": read and waiting for the checks to start (still collecting). */
  phase: z.enum(['reading', 'read', 'checking', 'done', 'failed']),
  outcome: z.enum(CHALLENGE_OUTCOMES),
  /**
   * For a cleared invoice: whether it was checked against the prospect's records, or only on its
   * own (no records were provided to compare it with).
   */
  basis: z.enum(['records', 'invoice']).nullable(),
  stages: z.array(ApiChallengeStageSchema),
  finding: ApiFindingSchema.nullable(),
  /** Other open points on the same invoice, in words. */
  more: z.array(z.string()),
  failure: z.object({ reason: z.string(), stage: z.string().nullable() }).nullable(),
  canRemove: z.boolean(),
  canRetry: z.boolean(),
});
export type ApiChallengeInvoice = z.infer<typeof ApiChallengeInvoiceSchema>;

export const ApiChallengeRecordFileSchema = z.object({
  name: z.string(),
  kind: z.enum(['template', 'receipts']),
  at: z.string(),
  /** What it added, in words ("12 suppliers, 30 purchase orders"). */
  summary: z.string(),
});

export const ApiChallengeSummarySchema = z.object({
  checked: int,
  totalPaise: int,
  /** Invoices whose total could not be read (not in the total). */
  totalUnread: int,
  cleared: int,
  clearedAgainstRecords: int,
  clearedInvoiceOnly: int,
  review: int,
  confirm: int,
  failed: int,
  attention: int,
  /** The invoice value of the invoices that need attention (never "money saved"). */
  reviewValuePaise: int,
  byType: z.record(z.string(), int),
});
export type ApiChallengeSummary = z.infer<typeof ApiChallengeSummarySchema>;

export const ApiChallengeStateSchema = z.object({
  id: z.string(),
  status: z.enum(CHALLENGE_STATUSES),
  /** Null until the prospect gives their details (after the headline result). */
  companyName: z.string().nullable(),
  email: z.string().nullable(),
  /**
   * Whether the full results (each finding, its evidence, the report) are open: once the details
   * are given. Before that, only the headline numbers are sent, by the server.
   */
  unlocked: z.boolean(),
  gstin: z.string().nullable(),
  /** Buyer GSTINs read on the invoices (to confirm the company's own), most frequent first. */
  gstinCandidates: z.array(z.object({ gstin: z.string(), invoices: int })),
  aiProvider: z.string().nullable(),
  maxInvoices: int,
  invoices: z.array(ApiChallengeInvoiceSchema),
  records: z.object({
    files: z.array(ApiChallengeRecordFileSchema),
    counts: z.record(z.string(), int),
  }),
  summary: ApiChallengeSummarySchema.nullable(),
  checksStartedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  expiresAt: z.string(),
  emailStatus: z.enum(CHALLENGE_EMAIL_STATUSES),
  interest: z.enum(CHALLENGE_INTERESTS),
  bookingUrl: z.string().nullable(),
});
export type ApiChallengeState = z.infer<typeof ApiChallengeStateSchema>;

export const ApiChallengeConfigSchema = z.object({
  enabled: z.boolean(),
  maxInvoices: int,
  aiProvider: z.string().nullable(),
  retentionDays: int,
  /** Hours the invoices are kept after the full results are shown, then deleted. */
  resultsHours: int,
  templates: z.array(z.object({ file: z.string(), title: z.string() })),
});
export type ApiChallengeConfig = z.infer<typeof ApiChallengeConfigSchema>;
