import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeErpConnector } from '@veyra/fake-erp';
import { scenarioById, scenarioExtraction, type FixtureScenario } from '@veyra/extractor';
import {
  headerPath,
  linePath,
  type ExtractionResult,
  type HeaderFieldKey,
  type LineFieldKey,
} from '@veyra/shared';
import { parseUserInput, readField, type StoredField } from './fields';
import { runEngine } from './run';
import type { AnsweredDecision, EngineInput, EngineSettings, OtherInvoice } from './types';

const SETTINGS: EngineSettings = {
  confidenceMinBp: 9000,
  poAutoCreateEnabled: true,
  poAutoCreateBelowPaise: 2_500_000,
};
let erp: FakeErpConnector;
let n = 0;
beforeAll(() => {
  erp = FakeErpConnector.open({ filename: ':memory:', reset: 'demo' });
});
afterAll(() => erp.close());

function fieldsOf(x: ExtractionResult): Map<string, StoredField> {
  const m = new Map<string, StoredField>();
  for (const [k, f] of Object.entries(x.header)) {
    const path = headerPath(k as HeaderFieldKey);
    m.set(path, {
      path,
      value: f.value as never,
      confidenceBp: f.confidenceBp,
      source: 'extracted',
      evidence: f.evidence,
      evidenceDetail: null,
    });
  }
  for (const l of x.lines) {
    for (const [k, f] of Object.entries(l)) {
      if (k === 'lineNo') continue;
      const path = linePath(l.lineNo, k as LineFieldKey);
      const ef = f as { value: unknown; confidenceBp: number; evidence: null };
      m.set(path, {
        path,
        value: ef.value as never,
        confidenceBp: ef.confidenceBp,
        source: 'extracted',
        evidence: ef.evidence,
        evidenceDetail: null,
      });
    }
  }
  return m;
}

function scenario(id: string, patch: Partial<FixtureScenario> = {}): ExtractionResult {
  const s = scenarioById(id);
  if (!s) throw new Error(id);
  return scenarioExtraction({ ...s, ...patch });
}

function run(x: ExtractionResult, over: Partial<EngineInput> = {}) {
  return runEngine({
    invoiceId: '01K00000000000000000000001',
    today: '2026-09-28',
    settings: SETTINGS,
    fields: fieldsOf(x),
    lineCount: x.lines.length,
    answers: [],
    existingActions: [],
    erp,
    otherInvoicesWithKey: async () => [],
    newId: () => `01K0000000000000000000${String(++n).padStart(4, '0')}`,
    ...over,
  });
}

const codes = (out: Awaited<ReturnType<typeof run>>) => out.questions.map((q) => q.code);
const rule = (out: Awaited<ReturnType<typeof run>>, code: string) =>
  out.validations.filter((r) => r.ruleCode === code);

describe('fields (RULES §1.3–1.4)', () => {
  it('a value below the confidence threshold is not usable, whatever it says', () => {
    const f = fieldsOf(scenario('S14'));
    expect(readField(f, 'header.totalPaise', 9000)).toMatchObject({
      state: 'low_confidence',
      value: null,
    });
    expect(readField(f, 'header.taxablePaise', 9000)).toMatchObject({
      state: 'usable',
      value: 1_360_000,
    });
  });

  it('human input is parsed strictly: never rounded, NOS and PCS stay distinct', () => {
    expect(parseUserInput('money', '16,048.00')).toEqual({ ok: true, value: 1_604_800 });
    expect(parseUserInput('money', '16048.005').ok).toBe(false);
    expect(parseUserInput('qty', '12.5')).toEqual({ ok: true, value: 12_500 });
    expect(parseUserInput('uom', 'pieces')).toEqual({ ok: true, value: 'PCS' });
    expect(parseUserInput('uom', 'bundle').ok).toBe(false);
    expect(parseUserInput('date', '17/09/2026')).toEqual({ ok: true, value: '2026-09-17' });
    expect(parseUserInput('date', '17/09/26').ok).toBe(false);
  });
});

describe('stage 1: the invoice on its own', () => {
  it('a clean invoice passes every rule and produces a commit plan', async () => {
    const out = await run(scenario('S01'));
    expect(out.questions).toEqual([]);
    expect(
      out.validations.every((r) => r.outcome === 'pass' || r.outcome === 'not_applicable'),
    ).toBe(true);
    expect(rule(out, 'R10')[0]).toMatchObject({
      outcome: 'not_applicable',
      naReason: 'NO_ROUND_OFF_LINE',
    });
    expect(out.plan?.invoice.totalPaise).toBe(11_387_000);
  });

  it('round-off: accepted only when printed and exactly to the nearest rupee', async () => {
    expect(rule(await run(scenario('S06')), 'R10')[0]?.outcome).toBe('pass');
    const wrong = await run(scenario('S06', { roundOffPaise: 49, totalPaise: 368_799 }));
    expect(rule(wrong, 'R10')[0]).toMatchObject({ outcome: 'fail', expected: 50, actual: 49 });
    expect(codes(wrong)).toContain('VF_R10');
    // A difference that is not printed as round-off is never absorbed.
    const unexplained = await run(scenario('S01', { totalPaise: 11_387_050 }));
    expect(rule(unexplained, 'R09')[0]?.outcome).toBe('fail');
  });

  it('tax: one paisa off fails; the tax type follows the states', async () => {
    const s12 = await run(scenario('S12'));
    expect(codes(s12)).toEqual(['VF_R07']);
    const s13 = await run(scenario('S13'));
    expect(codes(s13)).toEqual(['VF_R08']);
    expect(rule(await run(scenario('S02')), 'R08')[0]?.outcome).toBe('pass');
  });

  it('place of supply: printed, else ship-to evidence, else ask; never the buyer GSTIN', async () => {
    const shipTo = await run(
      scenario('S01', { placeOfSupply: null, shipTo: { state: 'Karnataka' } }),
    );
    expect(shipTo.questions).toEqual([]);
    expect(shipTo.derivedFields[0]).toMatchObject({
      path: 'header.placeOfSupply',
      value: '29',
      source: 'derived_from_document_evidence',
    });
    const nothing = await run(scenario('S01', { placeOfSupply: null }));
    expect(nothing.questions.map((q) => q.subjectKey)).toEqual(['header.placeOfSupply']);
    const conflicting = await run(
      scenario('S01', {
        placeOfSupply: null,
        shipTo: { state: 'Karnataka', gstin: '27AAACA4321M1ZT' },
      }),
    );
    expect(conflicting.questions.map((q) => q.subjectKey)).toEqual(['header.placeOfSupply']);
    const unreadable = await run(
      scenario('S01', { placeOfSupply: 'Atlantis', shipTo: { state: 'Karnataka' } }),
    );
    expect(unreadable.questions.map((q) => q.subjectKey)).toEqual(['header.placeOfSupply']);
  });

  it('duplicates: the ERP and other Veyrafy invoices both count; a match is asked, not rejected', async () => {
    const other: OtherInvoice = {
      id: 'x',
      state: 'NEEDS_INPUT',
      invoiceDate: '2026-09-15',
      totalPaise: 11_387_000,
    };
    const out = await run(scenario('S01'), { otherInvoicesWithKey: async () => [other] });
    expect(codes(out)).toEqual(['VF_R11']);
    expect(out.questions[0]?.options.map((o) => o.effect.type)).toEqual([
      'SET_FIELD',
      'RECHECK',
      'REJECT_INVOICE',
    ]);
    expect(out.duplicateKey).toEqual({
      vendorGstin: '29AAFCS5678K1ZK',
      invoiceNoNormalized: 'SSS/26-27/0451',
      fy: '2026-27',
    });
  });

  it('gating: an invalid GSTIN stops everything after stage 1, so no vendor is created', async () => {
    const out = await run(scenario('S15'));
    expect(codes(out)).toEqual(['VF_R03']);
    expect(out.actions).toEqual([]);
    expect(rule(out, 'R12')[0]?.outcome).toBe('not_evaluated');
  });

  it('an unreadable GSTIN with same-name suppliers asks which one; never links by name', async () => {
    const out = await run(scenario('S17'));
    expect(codes(out)).toEqual(['AM_VENDOR']);
    expect(out.vendor).toBeNull();
  });
});

describe('stages 2–4: vendor, items, PO and GRN', () => {
  it('new vendor with a valid GSTIN is staged automatically; the PO threshold is strict', async () => {
    const out = await run(scenario('S03'));
    expect(out.actions.map((a) => a.policyCode)).toEqual([
      'CP_VENDOR_AUTO',
      'CP_PO_BELOW_THRESHOLD',
    ]);
    expect(codes(out)).toEqual(['CA_GRN']);
    for (const r of ['R21', 'R22', 'R23', 'R24'])
      expect(rule(out, r)[0]).toMatchObject({
        outcome: 'not_applicable',
        naReason: 'PO_DERIVED_FROM_INVOICE',
      });
    const atLimit = await run(scenario('S03'), {
      settings: { ...SETTINGS, poAutoCreateBelowPaise: 1_097_600 },
    });
    expect(codes(atLimit)).toEqual(['CA_PO']);
    const disabled = await run(scenario('S03'), {
      settings: { ...SETTINGS, poAutoCreateEnabled: false },
    });
    expect(codes(disabled)).toEqual(['CA_PO']);
  });

  it('never creates a PO for a cited number that is missing, or while open POs exist', async () => {
    const s06 = await run(scenario('S06'));
    expect(codes(s06)).toEqual(['VF_R17']);
    expect(s06.actions).toEqual([]);
    const s07 = await run(scenario('S07'));
    expect(codes(s07)).toEqual(['AM_OPEN_PO']);
    expect(s07.actions).toEqual([]);
  });

  it('missing item → approval; the PO question waits for the item', async () => {
    const out = await run(scenario('S05'));
    expect(codes(out)).toEqual(['CA_ITEM']);
    expect(out.actions).toEqual([]);
  });

  it('three-way match: price, quantity received and unit must agree exactly', async () => {
    expect(codes(await run(scenario('S09')))).toEqual(['VF_R21']);
    expect(codes(await run(scenario('S10')))).toEqual(['VF_R26']);
    expect(codes(await run(scenario('S19')))).toEqual(['VF_R27']);
    expect(codes(await run(scenario('S08')))).toEqual(['CA_GRN']);
  });

  it('a GRN confirmation is data: it covers the invoice only with the quantities given', async () => {
    const q = (await run(scenario('S08'))).questions[0];
    const confirm = (accepted: number): AnsweredDecision => ({
      questionId: '01K0000000000000000000QQQ1',
      code: 'CA_GRN',
      subjectKey: q?.subjectKey ?? '',
      optionId: 'confirm',
      effect: { type: 'APPROVE_CREATION', entity: 'grn' },
      input: {
        grnDate: '2026-09-20',
        lines: [{ poLineNo: 1, receivedQtyMilli: 50_000, acceptedQtyMilli: accepted }],
      },
      userId: '00000000000000000000000001',
      seq: 1,
    });
    const full = await run(scenario('S08'), { answers: [confirm(50_000)] });
    expect(full.questions).toEqual([]);
    expect(full.actions.map((a) => a.policyCode)).toEqual(['CP_GRN_USER_CONFIRMED']);
    const short = await run(scenario('S08'), { answers: [confirm(40_000)] });
    expect(codes(short)).toEqual(['VF_R26']);
  });

  it('re-runs are deterministic: the same staged records keep the same ids', async () => {
    const first = await run(scenario('S03'));
    const second = await run(scenario('S03'), {
      existingActions: first.actions.map((a) => ({
        id: a.id,
        signature: a.signature,
        status: 'staged' as const,
      })),
    });
    expect(second.actions.map((a) => a.id)).toEqual(first.actions.map((a) => a.id));
  });

  it('no question offers an override', async () => {
    for (const id of [
      'S04',
      'S06',
      'S07',
      'S09',
      'S10',
      'S12',
      'S13',
      'S14',
      'S15',
      'S16',
      'S17',
      'S18',
      'S19',
    ]) {
      const out = await run(scenario(id));
      for (const q of out.questions) {
        expect(
          q.options.some((o) => o.effect.type === 'REJECT_INVOICE'),
          id,
        ).toBe(true);
        for (const o of q.options) expect(o.label).not.toMatch(/override|ignore|anyway/i);
      }
    }
  });
});
