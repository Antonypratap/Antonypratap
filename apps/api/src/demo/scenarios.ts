import { readFileSync } from 'node:fs';
import type { ApiDemoScenario } from '@veyra/shared';
import { VeyraError, type Veyra } from '../workflow/veyra';

/** The demo's sample businesses (docs/DEMO.md §1 and §10); the ERP seed is chosen in app.ts. */
export type DemoBusiness = 'brewery' | 'manufacturing';

/**
 * DEMO ONLY (Phase 3E): representative situations a prospect can start with one click. Each one
 * uploads a synthetic invoice from `fixtures/documents/` through the normal upload path, so the
 * real extractor and the unchanged workflow do everything that follows: nothing is scripted
 * beyond the choice of document. Registered only where the demo reset is (never in production).
 * Each sample business has its own documents, made up to match its ERP seed (docs/DEMO.md).
 */
export const DEMO_SCENARIOS: readonly (ApiDemoScenario & {
  files: Record<DemoBusiness, string>;
})[] = [
  {
    key: 'clean',
    title: 'Clean invoice',
    story: 'Everything matches the order and the goods receipt. Veyrafy handles it.',
    expect: 'handled',
    files: { manufacturing: 'D01-clean-text.pdf', brewery: 'brewery/B01-clean.pdf' },
  },
  {
    key: 'missing-receipt',
    title: 'Missing goods receipt',
    story: 'The order exists, but no one has recorded the goods arriving. Veyrafy asks.',
    expect: 'decision',
    files: { manufacturing: 'D12-missing-receipt.pdf', brewery: 'brewery/B02-missing-receipt.pdf' },
  },
  {
    key: 'ambiguous-supplier',
    title: 'Ambiguous supplier',
    story: 'No GSTIN on the invoice, and two suppliers share the name. Veyrafy asks which.',
    expect: 'decision',
    files: {
      manufacturing: 'D09-ambiguous-vendor.pdf',
      brewery: 'brewery/B03-ambiguous-supplier.pdf',
    },
  },
  {
    key: 'quantity-mismatch',
    title: 'Quantity mismatch',
    story: 'The invoice bills more than the order allows. Veyrafy stops and shows why.',
    expect: 'decision',
    files: {
      manufacturing: 'D07-quantity-mismatch.pdf',
      brewery: 'brewery/B04-quantity-mismatch.pdf',
    },
  },
  {
    key: 'rate-mismatch',
    title: 'Rate mismatch',
    story: 'The price differs from the purchase order. Veyrafy shows both.',
    expect: 'decision',
    files: { manufacturing: 'D08-rate-mismatch.pdf', brewery: 'brewery/B05-rate-mismatch.pdf' },
  },
  {
    key: 'unclear-scan',
    title: 'Photo needs confirmation',
    story:
      'A phone photo read by OCR. What Veyrafy could not read clearly, it asks you to confirm.',
    expect: 'decision',
    files: { manufacturing: 'D04-photo.png', brewery: 'brewery/B06-photo.png' },
  },
  {
    key: 'two-invoices',
    title: 'Two invoices in one file',
    story: 'Veyrafy will not merge them. It asks for one file per invoice.',
    expect: 'stopped',
    files: { manufacturing: 'D11-two-invoices.pdf', brewery: 'brewery/B07-two-invoices.pdf' },
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
  business: DemoBusiness,
): Promise<{ invoiceId: string; existing: boolean } | null> {
  const scenario = DEMO_SCENARIOS.find((s) => s.key === key);
  if (!scenario) return null;
  const file = scenario.files[business];
  const bytes = new Uint8Array(readFileSync(new URL(file, DOCS)));
  try {
    return {
      invoiceId: (await veyra.upload({ filename: file.split('/').pop() ?? file, bytes })).invoiceId,
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
