import { confidenceBp, type ExtractedHeader, type ExtractedLine } from '@veyra/shared';
import { rows, unitOf, type PageText, type Segment } from './layout';
import { parseAmount, parseDate } from './parse';

/**
 * OPTIONAL local-model assist (Ollama). Off unless `VEYRA_OLLAMA_URL` is set.
 *
 * Trust model: the model may only fill header fields the deterministic parser found NOTHING for
 * (not ambiguous ones: ambiguity is always asked), and only by quoting text that appears verbatim
 * in the document. The quote is then parsed by the same deterministic parsers as everything else,
 * and its confidence is capped at 0.50, below any sensible threshold: a model-proposed value is
 * therefore always shown to the designated user to confirm. The model's own confidence is ignored.
 */

const FIELDS = {
  vendorName: 'text',
  invoiceNumber: 'text',
  invoiceDate: 'date',
  poNumber: 'text',
  placeOfSupply: 'text',
  taxablePaise: 'money',
  cgstPaise: 'money',
  sgstPaise: 'money',
  igstPaise: 'money',
  totalPaise: 'money',
} as const satisfies Partial<Record<keyof ExtractedHeader, 'text' | 'date' | 'money'>>;
type AssistField = keyof typeof FIELDS;

/** Cap on model-proposed values (basis points): below the default 0.90 threshold by design. */
export const OLLAMA_MAX_CONFIDENCE_BP = 5000;

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

type Parsed = { header: ExtractedHeader; lines: ExtractedLine[] };

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export class OllamaAssist {
  readonly #o: Required<OllamaOptions>;

  constructor(options: OllamaOptions) {
    this.#o = { timeoutMs: 30_000, fetch: globalThis.fetch, ...options };
  }

  async fill(parsed: Parsed, pages: readonly PageText[]): Promise<Parsed & { warnings: string[] }> {
    const missing = (Object.keys(FIELDS) as AssistField[]).filter((k) => {
      const f = parsed.header[k];
      return f.value === null && f.evidence === null;
    });
    if (missing.length === 0) return { ...parsed, warnings: [] };
    const text = pages
      .map((p) =>
        rows(p.segments, unitOf(p.segments))
          .map((r) => r.map((s) => s.text).join('   '))
          .join('\n'),
      )
      .join('\n\n')
      .slice(0, 12_000);
    let answer: Record<string, unknown>;
    try {
      answer = await this.#ask(text, missing);
    } catch (error) {
      return {
        ...parsed,
        warnings: [
          `Local AI assist was not available (${error instanceof Error ? error.message : String(error)}).`,
        ],
      };
    }
    const header = { ...parsed.header };
    const filled: string[] = [];
    const segments = pages.flatMap((p) => p.segments);
    for (const key of missing) {
      const quote = answer[key];
      if (typeof quote !== 'string' || norm(quote) === '') continue;
      // Grounding: the quote must be printed on the document, or it is discarded.
      const seg = segments.find((s) => norm(s.text).includes(norm(quote)));
      if (!seg) continue;
      const value = parseAs(FIELDS[key], norm(quote));
      if (value === null) continue;
      (header as Record<string, unknown>)[key] = {
        value,
        confidenceBp: confidenceBp(Math.min(OLLAMA_MAX_CONFIDENCE_BP, Math.round(seg.conf * 100))),
        evidence: { page: seg.page, text: seg.text, bbox: bbox(seg) },
        source: 'ollama',
      };
      filled.push(key);
    }
    return {
      header,
      lines: parsed.lines,
      warnings: filled.length
        ? [`Local AI assist proposed: ${filled.join(', ')} (to be confirmed).`]
        : [],
    };
  }

  async #ask(text: string, fields: readonly AssistField[]): Promise<Record<string, unknown>> {
    const prompt = [
      'You read an Indian GST purchase invoice. Below is its text, exactly as printed.',
      `For each of these fields: ${fields.join(', ')}, copy the value EXACTLY as it is printed, character for character.`,
      'If a value is not printed, use null. Never compute, infer, reformat or guess a value.',
      'Answer with one JSON object whose keys are the field names.',
      '',
      text,
    ].join('\n');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#o.timeoutMs);
    try {
      const res = await this.#o.fetch(`${this.#o.baseUrl.replace(/\/$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.#o.model,
          prompt,
          format: 'json',
          stream: false,
          options: { temperature: 0 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { response?: unknown };
      const parsed: unknown = JSON.parse(String(body.response ?? '{}'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseAs(kind: 'text' | 'date' | 'money', text: string): string | number | null {
  if (kind === 'date') return parseDate(text);
  if (kind === 'money') return parseAmount(text);
  return text;
}

const bbox = (s: Segment): [number, number, number, number] => [
  s.x0,
  s.y0,
  s.x1 - s.x0,
  s.y1 - s.y0,
];
