import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import {
  DOCUMENT_SAMPLES,
  SCENARIOS,
  renderScenario,
  type DocumentSample,
  type FixtureScenario,
} from '@veyra/extractor';
import { renderSample } from '../../../packages/extractor/src/cli/render-documents';

/**
 * Benchmark documents (synthetic only; never customer data). The demo scenarios are re-rendered
 * with a unique invoice number, so every upload is a new document (no duplicate refusal) that the
 * REAL extractor reads: digital PDFs through their text layer, photos through Tesseract OCR.
 */
export interface BenchDocument {
  file: string;
  bytes: Uint8Array;
  mime: string;
  scenario: string;
}

const run = randomBytes(3).toString('hex').toUpperCase();
let counter = 0;

function variant(s: FixtureScenario, kind: 'pdf' | 'photo'): BenchDocument {
  const n = ++counter;
  const invoiceNumber = `${s.invoiceNumber}-B${run}${n}`;
  const bytes = renderScenario({
    ...s,
    kind,
    invoiceNumber,
    weak: kind === 'photo' ? s.weak : undefined,
  } as FixtureScenario);
  return {
    file: `${s.id}-${n}.${kind === 'pdf' ? 'pdf' : 'png'}`,
    bytes,
    mime: kind === 'pdf' ? 'application/pdf' : 'image/png',
    scenario: s.id,
  };
}

const digitalScenarios = SCENARIOS.filter((s) => s.kind === 'pdf');

/** The i-th digital invoice: cycles through every digital demo scenario (mixed outcomes). */
export const digital = (i: number): BenchDocument => {
  const s = digitalScenarios[i % digitalScenarios.length];
  if (!s) throw new Error('no scenarios');
  return variant(s, 'pdf');
};

/** A digital re-render of one scenario. */
export const digitalOf = (id: string): BenchDocument => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return variant(s, 'pdf');
};

/** A photographed (PNG) re-render of one scenario: read with OCR. */
export const photoOf = (id: string): BenchDocument => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return variant(s, 'photo');
};

/** A PDF that cannot be read (extraction fails): the reprocess flow. */
export const broken = (): BenchDocument => ({
  file: `broken-${++counter}.pdf`,
  bytes: new TextEncoder().encode(
    `%PDF-1.4\n1 0 obj << /Garbage ${run}${counter} >>\ntrailer\n%%EOF\n`,
  ),
  mime: 'application/pdf',
  scenario: 'broken',
});

/** The synthetic real-extraction documents in fixtures/documents (D01–D12). */
export function fixtureDocuments(): {
  file: string;
  path: string;
  bytes: Uint8Array;
  mime: string;
}[] {
  const dir = fileURLToPath(new URL('../../../fixtures/documents/', import.meta.url));
  return readdirSync(dir)
    .filter((f) => /\.(pdf|png|jpe?g)$/i.test(f))
    .sort()
    .map((file) => ({
      file,
      path: dir + file,
      bytes: new Uint8Array(readFileSync(dir + file)),
      mime: file.endsWith('.pdf')
        ? 'application/pdf'
        : file.endsWith('.png')
          ? 'image/png'
          : 'image/jpeg',
    }));
}

// ── Realistic documents (the layouts the real parser is built for) ────────

let browser: Promise<Browser> | null = null;
const CHROMIUM = process.env.VEYRA_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let serial = 1000 + Math.floor(Math.random() * 8000);

/**
 * A fresh rendering of one of the real-extraction samples (fixtures/documents, D01–D12) with a
 * unique invoice number, rendered by Chromium exactly like the committed fixtures. Render before
 * timing: rendering is not part of Veyra.
 */
export async function realistic(prefix: string): Promise<BenchDocument> {
  const sample = DOCUMENT_SAMPLES.find((d) => d.file.startsWith(prefix));
  if (!sample) throw new Error(prefix);
  const n = ++serial;
  const variant: DocumentSample = {
    ...sample,
    invoices: sample.invoices.map((inv, i) => ({
      ...inv,
      number: inv.number.replace(/\d+$/, (d) => String(n * 10 + i).padStart(d.length, '0')),
    })),
  };
  browser ??= chromium.launch({ executablePath: CHROMIUM });
  const bytes = new Uint8Array(await renderSample(await browser, variant));
  const ext = sample.file.split('.').pop() ?? 'pdf';
  return {
    file: `${prefix}-${n}.${ext}`,
    bytes,
    mime: ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg',
    scenario: prefix,
  };
}

/** Renders many in advance (in order). */
export async function realisticMany(prefixes: string[]): Promise<BenchDocument[]> {
  const out: BenchDocument[] = [];
  for (const p of prefixes) out.push(await realistic(p));
  return out;
}

export async function closeRenderer(): Promise<void> {
  if (browser) await (await browser).close();
  browser = null;
}
