/**
 * Veyra performance benchmarks (Phase 7, docs/PERFORMANCE.md).
 *
 *   TEST_DATABASE_URL=postgres://… npm run bench -w @veyra/api -- <label> [suite…]
 *
 * Suites: db, api, erp, flows, answer, reprocess, ocr, queue (default: all). Results go to
 * bench/results/<label>.json, so a baseline and a later run can be compared (bench/compare.ts).
 * Every figure is a separate measurement: API, database, workflow, extraction, OCR, job queue and
 * ERP are never added into one number.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import {
  LocalDocumentExtractor,
  TesseractOcr,
  type Extractor,
  type OcrEngine,
} from '@veyra/extractor';
import * as t from '../src/db/schema';
import { timedOcr as appTimedOcr } from '../src/perf/timing';
import { DEMO_USER } from '../src/workflow/veyra';
import {
  broken,
  closeRenderer,
  fixtureDocuments,
  photoOf,
  realisticMany,
  type BenchDocument,
} from './documents';
import {
  benchApp,
  call,
  count,
  mb,
  now,
  stats,
  upload,
  waitSettled,
  type BenchApp,
  type Stats,
} from './lib';

const [label = 'run', ...only] = process.argv.slice(2);
const suites = only.length ? only : ['db', 'api', 'erp', 'flows', 'answer', 'reprocess', 'ocr'];
const results: Record<string, unknown> = {
  label,
  at: new Date().toISOString(),
  node: process.version,
};
const log = (...a: unknown[]) => console.log(...a);
const table = (title: string, rows: Record<string, Stats | (Stats & Record<string, unknown>)>) => {
  log(`\n${title}`);
  log(
    '  operation'.padEnd(48),
    'n'.padStart(5),
    'p50'.padStart(9),
    'p95'.padStart(9),
    'p99'.padStart(9),
    'max'.padStart(9),
    'err'.padStart(4),
  );
  for (const [k, s] of Object.entries(rows))
    log(
      `  ${k}`.padEnd(48),
      String(s.n).padStart(5),
      String(s.p50).padStart(9),
      String(s.p95).padStart(9),
      String(s.p99).padStart(9),
      String(s.max).padStart(9),
      String(s.errors).padStart(4),
    );
};

/** Timing wrappers for the extractor and its OCR engine (from the outside). */
function timedExtractor() {
  const extract: number[] = [];
  const ocr: number[] = [];
  // Wrapped like the app does (OCR is its own stage in the job's timing).
  const engine = appTimedOcr(new TesseractOcr());
  const timedOcr: OcrEngine = new Proxy(engine, {
    get(target, prop, receiver) {
      const v: unknown = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      if (prop !== 'recognize') return (v as (...a: unknown[]) => unknown).bind(target);
      return async (...args: unknown[]) => {
        const s = now();
        try {
          return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } finally {
          ocr.push(now() - s);
        }
      };
    },
  });
  const real = new LocalDocumentExtractor({ ocr: timedOcr });
  const extractor: Extractor & { close: () => Promise<void> } = {
    id: real.id,
    version: real.version,
    isAvailable: () => real.isAvailable(),
    extract: async (input) => {
      const s = now();
      try {
        return await real.extract(input);
      } finally {
        extract.push(now() - s);
      }
    },
    close: () => real.close(),
  };
  return { extractor, extract, ocr };
}

/** Records when each job was claimed and how long it ran (wrapping the instance's methods). */
function timeJobs(b: BenchApp) {
  const veyra = b.app.veyra;
  const claimedAt = new Map<string, number>();
  const exec: { type: string; ms: number }[] = [];
  const claim = veyra.claimJob.bind(veyra);
  veyra.claimJob = async () => {
    const job = await claim();
    if (job) claimedAt.set(job.id, Date.now());
    return job;
  };
  for (const [name, type] of [
    ['runPipeline', 'pipeline'],
    ['runCommit', 'commit'],
  ] as const) {
    const fn = veyra[name].bind(veyra);
    veyra[name] = async (id: string) => {
      const s = now();
      try {
        return await fn(id);
      } finally {
        exec.push({ type, ms: now() - s });
      }
    };
  }
  return {
    exec,
    async summary() {
      const rows = await veyra.db.select().from(t.jobs);
      const waits = rows
        .filter((r) => claimedAt.has(r.id))
        .map(
          (r) =>
            (claimedAt.get(r.id) ?? 0) - Math.max(Date.parse(r.runAfter), Date.parse(r.createdAt)),
        );
      return {
        queueWaitMs: stats(waits),
        execPipelineMs: stats(exec.filter((e) => e.type === 'pipeline').map((e) => e.ms)),
        execCommitMs: stats(exec.filter((e) => e.type === 'commit').map((e) => e.ms)),
      };
    },
  };
}

/** Text PDFs the real parser reads, with every outcome: verified, questions, a failure. */
const DIGITAL_MIX = ['D01', 'D07', 'D08', 'D09', 'D10', 'D12', 'D06'];
/** Scans and photos (OCR): scanned PDF, JPEG, PNG, blurry JPEG. */
const PHOTO_MIX = ['D02', 'D03', 'D04', 'D05'];
const cycle = (mix: string[], n: number) =>
  Array.from({ length: n }, (_, i) => mix[i % mix.length] ?? 'D01');

async function seed(b: BenchApp, n: number) {
  const docs = await realisticMany(cycle(DIGITAL_MIX, n));
  const ids: string[] = [];
  for (const d of docs) {
    const r = await upload(b, d.file, d.bytes, d.mime);
    if (r.status !== 201) throw new Error(`seed upload ${r.status} ${JSON.stringify(r.json)}`);
    ids.push((r.json as { invoiceId: string }).invoiceId);
  }
  const settled = await waitSettled(b, ids, now());
  return { ids, states: count([...settled.values()].map((s) => s.state)) };
}

// ── Suites ────────────────────────────────────────────────────────────────

async function dbSuite() {
  const b = await benchApp();
  try {
    await seed(b, 20);
    const db = b.app.veyra.db;
    const inv = (await db.select({ id: t.invoices.id }).from(t.invoices).limit(1))[0]?.id ?? '';
    const measure = async (n: number, fn: () => Promise<unknown>) => {
      for (let i = 0; i < 20; i++) await fn(); // warm-up
      const s: number[] = [];
      for (let i = 0; i < n; i++) {
        const t0 = now();
        await fn();
        s.push(now() - t0);
      }
      return stats(s);
    };
    const token = b.session.cookie.split('=')[1] ?? '';
    const rows = {
      'select 1 (pool round trip)': await measure(1000, () => db.execute(sql`select 1`)),
      'invoice by id': await measure(1000, () => b.app.veyra.invoiceRow(db, inv)),
      'settings (all rows)': await measure(1000, () => b.app.veyra.settings()),
      'session resolve (auth)': await measure(1000, () => b.app.sessions.resolve(token)),
      'user by id (requireActor)': await measure(1000, () =>
        b.app.veyra.requireActor(DEMO_USER.id, 'invoices.view'),
      ),
    };
    table('DATABASE (ms, sequential, one connection at a time)', rows);
    results.db = rows;
  } finally {
    await b.close();
  }
}

const ENDPOINTS = (inv: string, doc: string) =>
  [
    ['GET /auth/session', '/auth/session'],
    ['GET /invoices (inbox)', '/invoices'],
    ['GET /invoices/:id (detail)', `/invoices/${inv}`],
    ['GET /questions (open)', '/questions'],
    ['GET /questions?status=answered', '/questions?status=answered'],
    ['GET /audit?invoiceId', `/audit?invoiceId=${inv}`],
    ['GET /audit (all)', '/audit'],
    ['GET /documents', '/documents'],
    ['GET /documents/:id', `/documents/${doc}`],
    ['GET /documents/:id/file', `/documents/${doc}/file`],
    ['GET /erp/connection', '/erp/connection'],
    ['GET /erp/vendors', '/erp/vendors'],
    ['GET /erp/purchase-orders', '/erp/purchase-orders'],
    ['GET /erp/grns', '/erp/grns'],
    ['GET /imports', '/imports'],
    ['GET /health/ready', '/health/ready'],
  ] as const;

async function apiSuite() {
  const out: Record<string, unknown> = {};
  for (const size of [40, 200]) {
    const b = await benchApp();
    try {
      const t0 = now();
      const seeded = await seed(b, size);
      const seedMs = now() - t0;
      const inv = seeded.ids[0] ?? '';
      const doc = (await b.app.veyra.invoiceRow(b.app.veyra.db, inv)).documentId;
      const rows: Record<string, Stats & { bytes: number; brotliBytes: number; brotliMs: number }> =
        {};
      for (const [name, path] of ENDPOINTS(inv, doc)) {
        for (let i = 0; i < 10; i++) await call(b, 'GET', path); // warm-up
        const s: number[] = [];
        let errors = 0;
        let bytes = 0;
        for (let i = 0; i < 100; i++) {
          const r = await call(b, 'GET', path);
          if (r.status !== 200) errors++;
          else s.push(r.ms);
          bytes = r.bytes;
        }
        // What compression does to this response (the plugin's settings: brotli quality 4).
        const body = await (
          await fetch(`${b.base}${path}`, {
            headers: { ...b.session.headers, 'accept-encoding': 'identity' },
          })
        ).arrayBuffer();
        const c0 = now();
        const br = brotliCompressSync(Buffer.from(body), {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
        });
        const brMs = Math.round((now() - c0) * 100) / 100;
        rows[name] = { ...stats(s, errors), bytes, brotliBytes: br.length, brotliMs: brMs };
      }
      table(`API over HTTP, ${size} invoices (ms, sequential, 100 requests each)`, rows);
      out[`invoices${size}`] = {
        states: seeded.states,
        seedMs: Math.round(seedMs),
        endpoints: rows,
      };
      // Concurrency: 10 clients loading the inbox at once.
      for (const clients of [10]) {
        const s: number[] = [];
        let errors = 0;
        const wall0 = now();
        await Promise.all(
          Array.from({ length: clients }, async () => {
            for (let i = 0; i < 30; i++) {
              const r = await call(b, 'GET', '/invoices');
              if (r.status === 200) s.push(r.ms);
              else errors++;
            }
          }),
        );
        const st = stats(s, errors, now() - wall0);
        table(`Inbox, ${clients} concurrent clients × 30 (${size} invoices)`, {
          'GET /invoices': st,
        });
        (out[`invoices${size}`] as Record<string, unknown>)[`inboxConcurrent${clients}`] = st;
      }
    } finally {
      await b.close();
    }
  }
  results.api = out;
}

async function erpSuite() {
  const b = await benchApp();
  try {
    // Direct connector reads (fake ERP, SQLite in-process): Veyra's side of an ERP read.
    const erp = b.app.veyra.erp;
    const vendors = await erp.listVendors();
    const pos = await erp.listPurchaseOrders();
    const v = vendors[0];
    const po = pos[0];
    if (!v || !po) throw new Error('no seed');
    const line = po.lines[0];
    const ops: [string, () => Promise<unknown>][] = [
      ['getCompany', () => erp.getCompany()],
      ['findVendorByGstin', () => erp.findVendorByGstin(v.gstin as never)],
      ['getVendor', () => erp.getVendor(v.id)],
      [
        'findVendorsByNormalizedName',
        () => erp.findVendorsByNormalizedName('shakti steel suppliers'),
      ],
      ['getPurchaseOrderByNumber', () => erp.getPurchaseOrderByNumber(po.poNumber)],
      ['listOpenPurchaseOrders', () => erp.listOpenPurchaseOrders(v.id)],
      ['listGrnsForPo', () => erp.listGrnsForPo(po.id)],
      ['getInvoicedQtyByPoLine', () => erp.getInvoicedQtyByPoLine(line?.id as never)],
      ['listVendors (browser)', () => erp.listVendors()],
      ['listPurchaseOrders (browser)', () => erp.listPurchaseOrders()],
    ];
    const rows: Record<string, Stats> = {};
    for (const [name, fn] of ops) {
      for (let i = 0; i < 20; i++) await fn();
      const s: number[] = [];
      for (let i = 0; i < 500; i++) {
        const t0 = now();
        await fn();
        s.push(now() - t0);
      }
      rows[name] = stats(s);
    }
    table('ERP connector reads, fake ERP (ms, 500 each; includes the capability guard)', rows);
    results.erp = rows;
  } finally {
    await b.close();
  }
}

/** FLOW B (digital PDF) and FLOW C (photos, OCR): upload → settled, one at a time. */
async function flowsSuite() {
  const out: Record<string, unknown> = {};
  for (const kind of ['digital', 'photo'] as const) {
    const ex = timedExtractor();
    const b = await benchApp({ documentExtractor: ex.extractor });
    const jobs = timeJobs(b);
    try {
      // Warm-up (first OCR loads the engine): not measured.
      const [w, ...docs] = await realisticMany(
        cycle(kind === 'digital' ? DIGITAL_MIX : PHOTO_MIX, kind === 'digital' ? 41 : 13),
      );
      if (!w) throw new Error('no documents');
      const wr = await upload(b, w.file, w.bytes, w.mime);
      await waitSettled(b, [(wr.json as { invoiceId: string }).invoiceId], now());
      ex.extract.length = 0;
      ex.ocr.length = 0;
      jobs.exec.length = 0;
      b.erp.reset();
      const uploadMs: number[] = [];
      const settleMs: number[] = [];
      const states: string[] = [];
      const n = docs.length;
      for (const d of docs as BenchDocument[]) {
        const t0 = now();
        const r = await upload(b, d.file, d.bytes, d.mime);
        uploadMs.push(r.ms);
        const id = (r.json as { invoiceId: string }).invoiceId;
        const done = await waitSettled(b, [id], t0);
        settleMs.push(done.get(id)?.ms ?? 0);
        states.push(done.get(id)?.state ?? '?');
      }
      const rows = {
        'POST /documents (upload API)': stats(uploadMs),
        'upload → settled (end to end)': stats(settleMs),
        'extraction (whole extractor)': stats(ex.extract),
        ...(ex.ocr.length ? { 'OCR (Tesseract recognize)': stats(ex.ocr) } : {}),
        ...(await jobs.summary()),
      };
      table(
        `FLOW ${kind === 'digital' ? 'B digital PDF' : 'C photo (OCR)'} (ms, ${n} invoices one at a time)`,
        rows,
      );
      const stages = b.stageStats();
      if (Object.keys(stages).length)
        table('  stages per job (instrumented, exclusive ms)', stages);
      table('  ERP connector calls during the flow', b.erp.summary());
      out[kind] = { rows, states: count(states), erp: b.erp.summary(), stages: b.stageStats() };
    } finally {
      await b.close();
    }
  }
  results.flows = out;
}

/** FLOW D: answer a question (the missing goods receipt of S08), fresh demo ERP each time. */
async function answerSuite() {
  const b = await benchApp();
  const jobs = timeJobs(b);
  try {
    const answerMs: number[] = [];
    const settleMs: number[] = [];
    const states: string[] = [];
    const docs = await realisticMany(cycle(['D12'], 21));
    for (const [i, d] of docs.entries()) {
      await call(b, 'POST', '/dev/reset', { erp: 'demo' });
      const r = await upload(b, d.file, d.bytes, d.mime);
      const id = (r.json as { invoiceId: string }).invoiceId;
      await waitSettled(b, [id], now());
      const q = (
        await b.app.veyra.db.select().from(t.questions).where(eq(t.questions.invoiceId, id))
      ).find((x) => x.status === 'open');
      if (!q || q.code !== 'CA_GRN') throw new Error(`expected CA_GRN, got ${q?.code}`);
      const input = answerInput(q.inputSchemaJson);
      b.erp.reset();
      const t0 = now();
      const a = await call(b, 'POST', `/questions/${q.id}/answer`, { optionId: 'confirm', input });
      if (a.status !== 200) throw new Error(`answer ${a.status} ${JSON.stringify(a.json)}`);
      if (i > 0) answerMs.push(a.ms); // the first is a warm-up
      const done = await waitSettled(b, [id], t0);
      if (i > 0) settleMs.push(done.get(id)?.ms ?? 0);
      states.push(done.get(id)?.state ?? '?');
    }
    const rows = {
      'POST /questions/:id/answer (API)': stats(answerMs),
      'answer → settled (incl. ERP commit)': stats(settleMs),
      ...(await jobs.summary()),
    };
    table('FLOW D answer the goods-receipt question of D12 (ms, 20 answers)', rows);
    results.answer = { rows, states: count(states), erpLastAnswer: b.erp.summary() };
  } finally {
    await b.close();
  }
}

/** The CA_GRN "confirm" input: every PO line received and accepted as suggested (invoiced). */
function answerInput(inputSchemaJson: string | null): unknown {
  const spec = (
    JSON.parse(inputSchemaJson ?? '{}') as Record<
      string,
      { lines?: { poLineNo: number; suggestedQty: string }[]; minDate?: string } | undefined
    >
  ).confirm;
  return {
    grnDate: spec?.minDate ?? '2026-09-20',
    lines: (spec?.lines ?? []).map((l) => ({
      poLineNo: l.poLineNo,
      received: l.suggestedQty,
      accepted: l.suggestedQty,
    })),
  };
}

/** FLOW E: reprocess a failed invoice. */
async function reprocessSuite() {
  const b = await benchApp();
  try {
    const apiMs: number[] = [];
    const settleMs: number[] = [];
    for (let i = 0; i < 31; i++) {
      const d = broken();
      const r = await upload(b, d.file, d.bytes, d.mime);
      const id = (r.json as { invoiceId: string }).invoiceId;
      await waitSettled(b, [id], now());
      const t0 = now();
      const p = await call(b, 'POST', `/invoices/${id}/reprocess`, {});
      if (p.status !== 200) throw new Error(`reprocess ${p.status}`);
      const done = await waitSettled(b, [id], t0);
      if (i > 0) {
        apiMs.push(p.ms);
        settleMs.push(done.get(id)?.ms ?? 0);
      }
    }
    const rows = {
      'POST /invoices/:id/reprocess (API)': stats(apiMs),
      'reprocess → settled (job + extraction)': stats(settleMs),
    };
    table('FLOW E reprocess (ms, 30)', rows);
    results.reprocess = rows;
  } finally {
    await b.close();
  }
}

/** Document extraction and OCR by document (the real extractor, in-process). */
async function ocrSuite() {
  const ocrTimes: number[] = [];
  const engine = new TesseractOcr();
  const timed: OcrEngine = new Proxy(engine, {
    get(target, prop, receiver) {
      const v: unknown = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      if (prop !== 'recognize') return (v as (...a: unknown[]) => unknown).bind(target);
      return async (...args: unknown[]) => {
        const s = now();
        try {
          return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } finally {
          ocrTimes.push(now() - s);
        }
      };
    },
  });
  const ex = new LocalDocumentExtractor({ ocr: timed });
  const docs = [
    ...fixtureDocuments(),
    ...['S01', 'S17'].map((id) => {
      const d = photoOf(id);
      return { file: `generated-photo-${id}.png`, path: '', bytes: d.bytes, mime: d.mime };
    }),
  ];
  const dir = join(tmpdir(), `veyra-bench-ocr-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const rows: Record<string, Stats & Record<string, unknown>> = {};
  // The first OCR in a process starts the Tesseract worker: measured on its own.
  const first = docs.find((d) => d.mime !== 'application/pdf');
  if (first) {
    const p = join(dir, 'warm');
    await writeFile(p, first.bytes);
    const s = now();
    await ex
      .extract({ documentId: 'w', filePath: p, mime: first.mime, sha256: '' })
      .catch(() => undefined);
    results.ocrColdStartMs = Math.round(now() - s);
    log(`\nOCR cold start (first document in a process): ${results.ocrColdStartMs} ms`);
  }
  for (const d of docs) {
    const p = join(dir, d.file);
    await writeFile(p, d.bytes);
    const total: number[] = [];
    const ocr: number[] = [];
    let pages: unknown = null;
    let outcome = 'ok';
    const rss0 = process.memoryUsage().rss;
    for (let i = 0; i < 3; i++) {
      ocrTimes.length = 0;
      const s = now();
      try {
        const r = await ex.extract({ documentId: 'b', filePath: p, mime: d.mime, sha256: '' });
        pages = r.pages;
      } catch (e) {
        outcome = (e as { code?: string }).code ?? 'error';
      }
      total.push(now() - s);
      ocr.push(ocrTimes.reduce((a, b2) => a + b2, 0));
    }
    rows[d.file] = {
      ...stats(total),
      ocrMedianMs: stats(ocr).p50,
      kb: Math.round(d.bytes.length / 1024),
      pages,
      outcome,
      rssDeltaMb: mb(process.memoryUsage().rss - rss0),
    };
  }
  log('\nEXTRACTION per document (ms, 3 runs each; ocrMedianMs = time inside Tesseract)');
  for (const [k, r] of Object.entries(rows))
    log(
      `  ${k.padEnd(34)} kb=${String(r.kb).padStart(5)} pages=${String(r.pages)} p50=${String(r.p50).padStart(8)} max=${String(r.max).padStart(8)} ocr=${String(r.ocrMedianMs).padStart(8)} ${String(r.outcome)}`,
    );
  results.extraction = rows;
  results.memory = {
    rssMb: mb(process.memoryUsage().rss),
    heapUsedMb: mb(process.memoryUsage().heapUsed),
  };
  await ex.close();
  await rm(dir, { recursive: true, force: true });
}

const RUN: Record<string, () => Promise<void>> = {
  db: dbSuite,
  api: apiSuite,
  erp: erpSuite,
  flows: flowsSuite,
  answer: answerSuite,
  reprocess: reprocessSuite,
  ocr: ocrSuite,
};

for (const s of suites) {
  const fn = RUN[s];
  if (!fn) throw new Error(`unknown suite ${s}`);
  const t0 = now();
  await fn();
  log(`[${s} done in ${Math.round((now() - t0) / 1000)} s]`);
}
await closeRenderer();
const dir = new URL('./results/', import.meta.url);
mkdirSync(dir, { recursive: true });
const file = new URL(`${label}.json`, dir);
writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
log(`\nwritten ${file.pathname}`);
process.exit(0);
