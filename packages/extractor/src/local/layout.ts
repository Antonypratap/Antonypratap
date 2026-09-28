import type { ExtractionMethod } from '@veyra/shared';

/**
 * Layout model shared by both reading paths. A segment is a run of text that belongs together
 * (a PDF text run, or OCR words close enough to be one phrase), with its box on the page and how
 * sure the reader was of it. The parser only ever sees segments: it does not know or care whether
 * they came from a text layer or from OCR, except through `conf` and `source`.
 */
export interface Segment {
  page: number;
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Reader confidence 0–100. Text-layer runs are exact (100); OCR words carry Tesseract's. */
  conf: number;
  source: Extract<ExtractionMethod, 'pdf_text' | 'tesseract'>;
  /** OCR only: each word with its own confidence, so a value is scored by its own words. */
  words?: { text: string; conf: number }[];
}

export interface PageText {
  page: number;
  segments: Segment[];
}

export const height = (s: Segment): number => s.y1 - s.y0;
export const yMid = (s: Segment): number => (s.y0 + s.y1) / 2;
export const xMid = (s: Segment): number => (s.x0 + s.x1) / 2;

/** Typical text height on a page: the unit for every layout tolerance. */
export function unitOf(segments: readonly Segment[]): number {
  const hs = segments
    .map(height)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  return hs[Math.floor(hs.length / 2)] ?? 10;
}

/** Groups segments into visual rows (same baseline band), each sorted left to right. */
export function rows(segments: readonly Segment[], unit: number): Segment[][] {
  const sorted = [...segments].sort((a, b) => yMid(a) - yMid(b) || a.x0 - b.x0);
  const out: Segment[][] = [];
  for (const s of sorted) {
    const row = out.at(-1);
    const rowMid = row ? row.reduce((n, r) => n + yMid(r), 0) / row.length : 0;
    if (row && Math.abs(yMid(s) - rowMid) <= unit * 0.5) row.push(s);
    else out.push([s]);
  }
  return out.map((r) => r.sort((a, b) => a.x0 - b.x0));
}

/** A new segment spanning several (their text joined with `sep`). */
export function joinSegments(parts: readonly Segment[], sep = ' '): Segment {
  const first = parts[0];
  if (!first) throw new Error('joinSegments needs at least one segment');
  return {
    page: first.page,
    text: parts.map((p) => p.text).join(sep),
    x0: Math.min(...parts.map((p) => p.x0)),
    y0: Math.min(...parts.map((p) => p.y0)),
    x1: Math.max(...parts.map((p) => p.x1)),
    y1: Math.max(...parts.map((p) => p.y1)),
    conf: Math.min(...parts.map((p) => p.conf)),
    source: parts.some((p) => p.source === 'tesseract') ? 'tesseract' : 'pdf_text',
    ...(parts.some((p) => p.words)
      ? { words: parts.flatMap((p) => p.words ?? [{ text: p.text, conf: p.conf }]) }
      : {}),
  };
}

/**
 * Confidence (0–100) of the part of some segments that spells `value`: the lowest confidence of
 * the OCR words that make up the value, not of the label printed next to it. Text-layer segments
 * are exact (100).
 */
export function valueConf(segs: readonly Segment[], value: string): number {
  if (segs.every((s) => s.source === 'pdf_text')) return 100;
  const squash = (t: string) => t.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const target = squash(value);
  const words = segs.flatMap((s) => s.words ?? [{ text: s.text, conf: s.conf }]);
  const used = words.filter((w) => {
    const t = squash(w.text);
    return t !== '' && target !== '' && (target.includes(t) || t.includes(target));
  });
  return used.length ? Math.min(...used.map((w) => w.conf)) : Math.min(...segs.map((s) => s.conf));
}

/**
 * OCR words → segments: words on one OCR line merge while the gap between them is small (about
 * one character height); a wider gap starts a new segment (another column of the layout).
 */
export function wordsToSegments(
  lines: readonly { words: readonly Omit<Segment, 'page' | 'source'>[] }[],
  page: number,
): Segment[] {
  const out: Segment[] = [];
  for (const line of lines) {
    const words = line.words.filter((w) => w.text.trim() !== '').sort((a, b) => a.x0 - b.x0);
    let run: Segment[] = [];
    const flush = () => {
      if (run.length) out.push(joinSegments(run));
      run = [];
    };
    for (const w of words) {
      const text = w.text.trim();
      const seg: Segment = {
        ...w,
        text,
        page,
        source: 'tesseract',
        words: [{ text, conf: w.conf }],
      };
      const prev = run.at(-1);
      const h = Math.max(height(seg), prev ? height(prev) : 0, 1);
      if (prev && seg.x0 - prev.x1 > h * 1.1) flush();
      run.push(seg);
    }
    flush();
  }
  return out;
}

/**
 * PDF text runs → segments. Runs on the same baseline that touch are merged (some producers emit
 * one run per word or glyph); a run containing a wide space gap is split, since that gap is
 * layout, not a word space.
 */
export function textRunsToSegments(runs: readonly Omit<Segment, 'source' | 'conf'>[]): Segment[] {
  const split: Segment[] = [];
  for (const r of runs) {
    const text = r.text.replace(/\s+$/, '');
    if (text.trim() === '') continue;
    const parts = text.split(/(\s{3,})/);
    if (parts.length === 1) {
      split.push({ ...r, text: text.trim(), conf: 100, source: 'pdf_text' });
      continue;
    }
    const perChar = (r.x1 - r.x0) / Math.max(text.length, 1);
    let at = 0;
    for (const p of parts) {
      if (p.trim() !== '')
        split.push({
          ...r,
          text: p.trim(),
          x0: r.x0 + at * perChar,
          x1: r.x0 + (at + p.length) * perChar,
          conf: 100,
          source: 'pdf_text',
        });
      at += p.length;
    }
  }
  const unit = unitOf(split);
  const out: Segment[] = [];
  for (const row of rows(split, unit)) {
    let run: Segment[] = [];
    for (const s of row) {
      const prev = run.at(-1);
      if (prev && s.x0 - prev.x1 > Math.max(height(s), 1) * 0.35) {
        out.push(joinSegments(run, ''));
        run = [];
      }
      if (prev && run.length && s.x0 - prev.x1 > Math.max(height(s), 1) * 0.12)
        s.text = ` ${s.text}`;
      run.push(s);
    }
    if (run.length) out.push(joinSegments(run, ''));
  }
  return out;
}
