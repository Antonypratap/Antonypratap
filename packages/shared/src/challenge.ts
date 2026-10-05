/**
 * The 5 Invoice Challenge (acquisition): a prospect puts up to five real supplier invoices, and
 * optionally their purchasing records, through the real Veyrafy checks and gets an evidence-based
 * report. These are the challenge record's states; the invoices themselves live in the
 * challenge's own isolated workspace and go through the product's own pipeline.
 */
export const CHALLENGE_MAX_INVOICES = 5;
/** Record files (template workbooks, CSVs, ERP receipt exports) per challenge. */
export const CHALLENGE_MAX_RECORD_FILES = 6;

/**
 * collecting: details given, invoices and records being added (invoices are read at once and
 *   held before the checks); checking: the checks run; complete: every invoice has a result;
 *   purged: the workspace (documents, readings) was deleted after the retention period, only
 *   the summary stays.
 */
export const CHALLENGE_STATUSES = ['collecting', 'checking', 'complete', 'purged'] as const;
export type ChallengeStatus = (typeof CHALLENGE_STATUSES)[number];

/** The follow-up e-mail to the prospect: never claimed as sent when it was not. */
export const CHALLENGE_EMAIL_STATUSES = ['not_sent', 'sent', 'failed', 'not_configured'] as const;
export type ChallengeEmailStatus = (typeof CHALLENGE_EMAIL_STATUSES)[number];

/** What the prospect asked for after the results. */
export const CHALLENGE_INTERESTS = ['none', 'walkthrough', 'pilot'] as const;
export type ChallengeInterest = (typeof CHALLENGE_INTERESTS)[number];

/** Where Veyrafy's follow-up stands (set by the Veyrafy team in the Control Centre). */
export const CHALLENGE_FOLLOW_UPS = [
  'new',
  'contacted',
  'walkthrough_booked',
  'pilot',
  'customer',
  'closed',
] as const;
export type ChallengeFollowUp = (typeof CHALLENGE_FOLLOW_UPS)[number];

/** One invoice's result in the challenge. */
export const CHALLENGE_OUTCOMES = ['processing', 'cleared', 'review', 'confirm', 'failed'] as const;
export type ChallengeOutcome = (typeof CHALLENGE_OUTCOMES)[number];

/** A finding's kind in a heading ("Rate difference"), for the results and the report. */
export const FINDING_TYPE_LABEL: Record<string, string> = {
  rate: 'Rate difference',
  quantity: 'Quantity difference',
  tax: 'Tax difference',
  totals: 'Totals do not add up',
  duplicate: 'Possible duplicate',
  supplier: 'Supplier to confirm',
  order: 'Purchase order',
  item: 'Item to confirm',
  receipt: 'Goods receipt',
  value: 'Value to confirm',
  other: 'Other',
};
