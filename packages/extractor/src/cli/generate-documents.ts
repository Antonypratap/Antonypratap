/**
 * `npm run fixtures:documents`: renders the synthetic invoices in `samples/documents.ts` to real
 * documents in `fixtures/documents/` with headless Chromium: text PDFs (print to PDF), JPEG and PNG
 * "photos" (screenshots), a scanned PDF (a JPEG page wrapped in a PDF with no text layer) and a
 * blurry photo.
 *
 * Unlike `fixtures/invoices/`, these files are not byte-deterministic (they depend on the
 * Chromium build), so they are committed and the tests assert what is READ from them, not their
 * hashes. Chromium: `VEYRA_CHROMIUM=/path/to/chrome`, or Playwright's installed browser.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { DOCUMENT_SAMPLES } from '../samples/documents';
import { renderSample } from './render-documents';

const OUT = fileURLToPath(new URL('../../../../fixtures/documents/', import.meta.url));

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  process.env.VEYRA_CHROMIUM ? { executablePath: process.env.VEYRA_CHROMIUM } : {},
);
try {
  // `npm run fixtures:documents -- D12` renders only the files starting with D12.
  const only = process.argv.slice(2);
  for (const sample of DOCUMENT_SAMPLES.filter(
    (x) => only.length === 0 || only.some((o) => x.file.startsWith(o)),
  )) {
    const bytes = await renderSample(browser, sample);
    writeFileSync(`${OUT}${sample.file}`, bytes);
    console.log(`${sample.file}  ${(bytes.length / 1024).toFixed(0)} KB  ${sample.title}`);
  }
} finally {
  await browser.close();
}
