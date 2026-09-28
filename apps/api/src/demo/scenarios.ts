import { readFileSync } from 'node:fs';
import type { ApiDemoScenario } from '@veyra/shared';
import { VeyraError, type Veyra } from '../workflow/veyra';

/**
 * DEMO ONLY (Phase 3E): representative situations a prospect can start with one click. Each one
 * uploads a synthetic invoice from `fixtures/documents/` through the normal upload path, so the
 * real extractor and the unchanged workflow do everything that follows: nothing is scripted
 * beyond the choice of document. Registered only where the demo reset is (never in production).
 */
export const DEMO_SCENARIOS: readonly (ApiDemoScenario & { file: string })[] = [
  {
    key: 'clean',
    title: 'Clean invoice',
    story: 'Everything matches the order and the goods receipt. Veyra handles it.',
    expect: 'handled',
    file: 'D01-clean-text.pdf',
  },
  {
    key: 'missing-receipt',
    title: 'Missing goods receipt',
    story: 'The order exists, but no one has recorded the goods arriving. Veyra asks.',
    expect: 'decision',
    file: 'D12-missing-receipt.pdf',
  },
  {
    key: 'ambiguous-supplier',
    title: 'Ambiguous supplier',
    story: 'No GSTIN on the invoice, and two suppliers share the name. Veyra asks which.',
    expect: 'decision',
    file: 'D09-ambiguous-vendor.pdf',
  },
  {
    key: 'quantity-mismatch',
    title: 'Quantity mismatch',
    story: 'The invoice bills more than the order allows. Veyra stops and shows why.',
    expect: 'decision',
    file: 'D07-quantity-mismatch.pdf',
  },
  {
    key: 'rate-mismatch',
    title: 'Rate mismatch',
    story: 'The price differs from the purchase order. Veyra shows both.',
    expect: 'decision',
    file: 'D08-rate-mismatch.pdf',
  },
  {
    key: 'unclear-scan',
    title: 'Photo needs confirmation',
    story: 'A phone photo read by OCR. What Veyra could not read clearly, it asks you to confirm.',
    expect: 'decision',
    file: 'D04-photo.png',
  },
  {
    key: 'two-invoices',
    title: 'Two invoices in one file',
    story: 'Veyra will not merge them. It asks for one file per invoice.',
    expect: 'stopped',
    file: 'D11-two-invoices.pdf',
  },
];

const DOCS = new URL('../../../../fixtures/documents/', import.meta.url);

/**
 * Starts a scenario: uploads its document exactly as a person would. If that exact file is
 * already in the workspace, the existing invoice is returned instead (uploads are unique by hash).
 */
export async function startScenario(
  veyra: Veyra,
  key: string,
): Promise<{ invoiceId: string; existing: boolean } | null> {
  const scenario = DEMO_SCENARIOS.find((s) => s.key === key);
  if (!scenario) return null;
  const bytes = new Uint8Array(readFileSync(new URL(scenario.file, DOCS)));
  try {
    return {
      invoiceId: (await veyra.upload({ filename: scenario.file, bytes })).invoiceId,
      existing: false,
    };
  } catch (error) {
    const invoiceId = error instanceof VeyraError ? error.details.invoiceId : null;
    if (
      error instanceof VeyraError &&
      error.code === 'DUPLICATE_UPLOAD' &&
      typeof invoiceId === 'string'
    )
      return { invoiceId, existing: true };
    throw error;
  }
}
