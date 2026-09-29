import { AsyncLocalStorage } from 'node:async_hooks';
import type { ErpConnector } from '@veyra/erp-connector';
import type { OcrEngine } from '@veyra/extractor';

/**
 * Lightweight stage timing (Phase 7, docs/PERFORMANCE.md).
 *
 * A job (or a request) opens a scope; the code marks its stages; the scope ends as one summary:
 * `{ EXTRACTION: { ms, n }, ERP_LOOKUP: { ms, n }, … }`. It is logged as ONE line per job next to
 * the job id and invoice id: no per-query or per-call log lines, and never any content (only
 * stage names, durations and counts).
 *
 * Stages are EXCLUSIVE, so they add up: time spent in a leaf (ERP calls, OCR, audit writes) is
 * counted in that leaf and not again in the stage around it (MATCHING excludes the ERP reads it
 * makes, EXTRACTION excludes OCR). Outside a scope every helper is a plain call.
 */
export const STAGES = [
  'UPLOAD',
  'EXTRACTION',
  'OCR',
  'VALIDATION',
  'MATCHING',
  'ERP_LOOKUP',
  'ERP_WRITE',
  'PERSIST',
  'QUESTION',
  'COMMIT',
  'AUDIT',
] as const;
export type Stage = (typeof STAGES)[number];
type Leaf = 'OCR' | 'ERP_LOOKUP' | 'ERP_WRITE' | 'AUDIT';

export interface TimingScope {
  totals: Map<Stage, { ms: number; n: number }>;
  /** Leaf time so far (subtracted from the enclosing stages). */
  leafMs: number;
}

const als = new AsyncLocalStorage<TimingScope>();

const add = (scope: TimingScope, stage: Stage, ms: number) => {
  const t = scope.totals.get(stage) ?? { ms: 0, n: 0 };
  t.ms += ms;
  t.n += 1;
  scope.totals.set(stage, t);
};

/** Runs `fn` in a new timing scope; returns its result and the stage summary. */
export async function timedScope<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stages: StageSummary }> {
  const scope: TimingScope = { totals: new Map(), leafMs: 0 };
  const result = await als.run(scope, fn);
  return { result, stages: summarize(scope) };
}

/** Like timedScope, but the summary is also available when `fn` throws. */
export async function withScope<T>(
  fn: () => Promise<T>,
  done: (stages: StageSummary, ok: boolean) => void,
): Promise<T> {
  const scope: TimingScope = { totals: new Map(), leafMs: 0 };
  let ok = false;
  try {
    const result = await als.run(scope, fn);
    ok = true;
    return result;
  } finally {
    done(summarize(scope), ok);
  }
}

/** A stage around `fn`, exclusive of the leaf work inside it. */
export async function stage<T>(name: Exclude<Stage, Leaf>, fn: () => Promise<T>): Promise<T> {
  const scope = als.getStore();
  if (!scope) return fn();
  const started = performance.now();
  const leaf0 = scope.leafMs;
  try {
    return await fn();
  } finally {
    const inner = scope.leafMs - leaf0;
    add(scope, name, performance.now() - started - inner);
    // The time of this stage is now accounted for: hide it from an enclosing stage.
    scope.leafMs = leaf0 + (performance.now() - started);
  }
}

/** A leaf (ERP call, OCR, audit write) around `fn`. */
export async function leaf<T>(name: Leaf, fn: () => Promise<T>): Promise<T> {
  const scope = als.getStore();
  if (!scope) return fn();
  const started = performance.now();
  try {
    return await fn();
  } finally {
    const ms = performance.now() - started;
    add(scope, name, ms);
    scope.leafMs += ms;
  }
}

export type StageSummary = Partial<Record<Stage, { ms: number; n: number }>>;

function summarize(scope: TimingScope): StageSummary {
  const out: StageSummary = {};
  for (const s of STAGES) {
    const t = scope.totals.get(s);
    if (t) out[s] = { ms: Math.round(t.ms * 10) / 10, n: t.n };
  }
  return out;
}

/** Connector operations that change the ERP (everything else is a read). */
const ERP_WRITES = new Set([
  'createVendor',
  'reactivateVendor',
  'createItem',
  'createVendorItemAlias',
  'createPurchaseOrder',
  'createGrn',
  'recordPurchaseInvoice',
  'importBusinessRecords',
]);

/**
 * Times every ERP connector call as ERP_LOOKUP or ERP_WRITE, without changing what it does,
 * returns or throws (the connector contract is untouched). Network time of a remote ERP will show
 * here, separately from Veyra's own processing.
 */
export function timedErp(erp: ErpConnector): ErpConnector {
  return new Proxy(erp, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (typeof prop !== 'string' || prop === 'capabilities' || prop === 'info')
        return fn.bind(target);
      const kind = ERP_WRITES.has(prop) ? 'ERP_WRITE' : 'ERP_LOOKUP';
      // Every operation but capabilities() is async; the timer starts before the call, since a
      // connector may do its work synchronously before returning the promise (the fake ERP).
      return (...args: unknown[]) => leaf(kind, async () => fn.apply(target, args));
    },
  });
}

/** Times OCR (Tesseract) separately from the rest of extraction. */
export function timedOcr(engine: OcrEngine): OcrEngine {
  return {
    get name() {
      return engine.name;
    },
    get version() {
      return engine.version;
    },
    recognize: (png) => leaf('OCR', () => engine.recognize(png)),
    close: () => engine.close(),
    warmUp: async () => {
      await engine.warmUp?.();
    },
  };
}
