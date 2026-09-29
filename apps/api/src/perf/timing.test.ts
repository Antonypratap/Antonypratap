import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ErpConnector } from '@veyra/erp-connector';
import { ErpNotFoundError } from '@veyra/erp-connector';
import { createLogger } from '../http/logging';
import { leaf, stage, timedErp, timedScope, withScope } from './timing';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('stage timing (Phase 7)', () => {
  it('stages are exclusive: leaf and nested time is not counted twice', async () => {
    const { result, stages } = await timedScope(async () => {
      await stage('EXTRACTION', async () => {
        await wait(20);
        await leaf('OCR', () => wait(40));
      });
      await stage('PERSIST', async () => {
        await stage('MATCHING', async () => {
          await leaf('ERP_LOOKUP', () => wait(30));
          await wait(20);
        });
        await leaf('AUDIT', () => wait(10));
        await wait(10);
      });
      return 'done';
    });
    expect(result).toBe('done');
    const ms = (k: keyof typeof stages) => stages[k]?.ms ?? 0;
    expect(ms('OCR')).toBeGreaterThanOrEqual(38);
    expect(ms('EXTRACTION')).toBeGreaterThanOrEqual(18);
    expect(ms('EXTRACTION')).toBeLessThan(40); // OCR excluded
    expect(ms('MATCHING')).toBeLessThan(30); // ERP excluded
    expect(ms('PERSIST')).toBeLessThan(25); // MATCHING, ERP and AUDIT excluded
    expect(stages.ERP_LOOKUP?.n).toBe(1);
  });

  it('outside a scope nothing is recorded and results pass through', async () => {
    expect(await stage('UPLOAD', async () => 7)).toBe(7);
    await expect(leaf('AUDIT', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
  });

  it('the summary is reported when the work fails too', async () => {
    let seen: unknown = null;
    await expect(
      withScope(
        () => stage('COMMIT', () => Promise.reject(new Error('boom'))),
        (s, ok) => {
          seen = { s, ok };
        },
      ),
    ).rejects.toThrow('boom');
    expect(seen).toMatchObject({ ok: false, s: { COMMIT: { n: 1 } } });
  });

  it('the ERP timing wrapper changes no result, error or sync member', async () => {
    const erp = {
      info: { name: 'x' },
      capabilities: () => ['read.vendors'],
      getCompany: async () => ({ name: 'Co' }),
      getVendor: async () => {
        throw new ErpNotFoundError('vendor', 'getVendor');
      },
      createGrn: async () => ({ id: 'g' }),
    } as unknown as ErpConnector;
    const timed = timedErp(erp);
    expect(timed.capabilities()).toEqual(['read.vendors']);
    expect(timed.info).toEqual({ name: 'x' });
    const { stages } = await timedScope(async () => {
      expect(await timed.getCompany()).toEqual({ name: 'Co' });
      await expect(timed.getVendor('v' as never)).rejects.toBeInstanceOf(ErpNotFoundError);
      await timed.createGrn({} as never, 'k' as never);
    });
    expect(stages.ERP_LOOKUP?.n).toBe(2);
    expect(stages.ERP_WRITE?.n).toBe(1);
  });

  it('a stage summary survives log redaction (names and numbers only)', () => {
    const lines: string[] = [];
    const log = createLogger(
      { level: 'info', environment: 'staging' },
      new Writable({
        write(c: Buffer, _e, done) {
          lines.push(c.toString());
          done();
        },
      }),
    );
    log.info(
      { jobId: 'j', stages: { OCR: { ms: 12.5, n: 1 }, EXTRACTION: { ms: 3, n: 1 } } },
      'job',
    );
    log.info({ ocrText: 'TAX INVOICE 27ABCDE1234F1Z5' }, 'oops');
    const out = lines.join('');
    expect(out).toContain('"OCR":{"ms":12.5,"n":1}');
    expect(out).not.toContain('TAX INVOICE');
  });
});
