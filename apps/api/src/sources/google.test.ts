import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GoogleSheets, parseServiceAccount } from './google';
import { parseSheetLink, SheetsError } from './sheets';

/** Google Sheets read-only access, against a fake Google (no network). A key made for the test. */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ACCOUNT = {
  client_email: 'veyrafy-sheets@veyrafy-test.iam.gserviceaccount.com',
  private_key: PEM,
};
const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd';

type Call = { url: string; init: RequestInit | undefined };
function fakeGoogle(sheets: (url: URL) => Response) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token')
      return Response.json({ access_token: 'token-1', expires_in: 3600 });
    return sheets(new URL(url));
  }) as typeof fetch;
  return { fetch: f, calls };
}

const grid = (rows: (Record<string, unknown> | null)[][]) =>
  Response.json({
    sheets: [{ data: [{ rowData: rows.map((r) => ({ values: r.map((v) => v ?? {}) })) }] }],
  });

describe('Google Sheets', () => {
  it('signs in with a token for read-only access, signed by the service account', async () => {
    const g = fakeGoogle(() =>
      Response.json({
        properties: { title: 'Purchases' },
        sheets: [{ properties: { title: 'Register', sheetId: 0 } }],
      }),
    );
    const sheets = new GoogleSheets(ACCOUNT, {
      fetch: g.fetch,
      now: () => Date.parse('2026-10-08T10:00:00Z'),
    });
    expect(await sheets.open(ID)).toEqual({
      title: 'Purchases',
      tabs: [{ title: 'Register', gid: 0 }],
    });
    await sheets.open(ID);
    // One token, reused; then two reads.
    expect(g.calls.map((c) => new URL(c.url).host)).toEqual([
      'oauth2.googleapis.com',
      'sheets.googleapis.com',
      'sheets.googleapis.com',
    ]);
    const form = new URLSearchParams(String(g.calls[0]?.init?.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c, s] = (form.get('assertion') ?? '').split('.');
    expect(
      createVerify('RSA-SHA256')
        .update(`${h}.${c}`)
        .verify(publicKey, s ?? '', 'base64url'),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(c ?? '', 'base64url').toString())).toMatchObject({
      iss: ACCOUNT.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
      aud: 'https://oauth2.googleapis.com/token',
    });
    // The token travels in a header, never in the address.
    const read = g.calls[1];
    expect((read?.init?.headers as Record<string, string>).authorization).toBe('Bearer token-1');
    expect(read?.url).not.toContain('token-1');
  });

  it('reads a tab as the .xlsx reader would: dates, percentages, booleans, errors, row numbers', async () => {
    let asked: URL | null = null;
    const g = fakeGoogle((url) => {
      asked = url;
      return grid([
        [
          { effectiveValue: { stringValue: 'Bill No' } },
          { effectiveValue: { stringValue: 'Bill Date' } },
        ],
        [],
        [
          { effectiveValue: { stringValue: 'B-1' } },
          {
            effectiveValue: { numberValue: 46000 },
            effectiveFormat: { numberFormat: { type: 'DATE' } },
          },
          {
            effectiveValue: { numberValue: 0.18 },
            effectiveFormat: { numberFormat: { type: 'PERCENT' } },
          },
          { effectiveValue: { boolValue: true } },
          { effectiveValue: { errorValue: { type: 'DIVIDE_BY_ZERO' } }, formattedValue: '#DIV/0!' },
          null,
        ],
      ]);
    });
    const rows = await new GoogleSheets(ACCOUNT, { fetch: g.fetch }).readTab(ID, "Raj's register");
    expect((asked as URL | null)?.searchParams.get('ranges')).toBe("'Raj''s register'!A1:BH20001");
    expect(rows).toEqual([
      {
        rowNumber: 1,
        cells: [
          { text: 'Bill No', kind: 'string', format: null, formula: false },
          { text: 'Bill Date', kind: 'string', format: null, formula: false },
        ],
      },
      {
        rowNumber: 3,
        cells: [
          { text: 'B-1', kind: 'string', format: null, formula: false },
          { text: '46000', kind: 'number', format: 'date', formula: false },
          { text: '0.18', kind: 'number', format: 'percent', formula: false },
          { text: 'TRUE', kind: 'boolean', format: null, formula: false },
          { text: '#DIV/0!', kind: 'error', format: null, formula: false },
        ],
      },
    ]);
  });

  it('says what to do when the sheet is not shared, not found, not a sheet, or Google is down', async () => {
    const failing = (status: number) =>
      new GoogleSheets(ACCOUNT, { fetch: fakeGoogle(() => new Response('{}', { status })).fetch });
    await expect(failing(403).open(ID)).rejects.toThrow(
      `Share it with ${ACCOUNT.client_email} as Viewer`,
    );
    await expect(failing(404).open(ID)).rejects.toThrow(/doesn't open a Google Sheet/);
    await expect(failing(400).open(ID)).rejects.toThrow(/Save as Google Sheets/);
    await expect(failing(503).open(ID)).rejects.toMatchObject({ reason: 'unavailable' });
    const offline = new GoogleSheets(ACCOUNT, {
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await expect(offline.open(ID)).rejects.toBeInstanceOf(SheetsError);
  });

  it('refuses a tab over the row limit instead of cutting it short', async () => {
    const many = Array.from({ length: 20_001 }, (_, i) => [{ effectiveValue: { numberValue: i } }]);
    const g = fakeGoogle(() => grid(many));
    await expect(
      new GoogleSheets(ACCOUNT, { fetch: g.fetch }).readTab(ID, 'Register'),
    ).rejects.toMatchObject({
      reason: 'too_large',
    });
  });

  it('takes the service account key as JSON or base64, and refuses anything else without echoing it', () => {
    const json = JSON.stringify({ type: 'service_account', ...ACCOUNT, private_key_id: 'x' });
    expect(parseServiceAccount(json)).toEqual(ACCOUNT);
    expect(parseServiceAccount(Buffer.from(json).toString('base64'))).toEqual(ACCOUNT);
    for (const bad of [
      'not json',
      JSON.stringify({ client_email: 'me@gmail.com', private_key: PEM }),
    ]) {
      let message = '';
      try {
        parseServiceAccount(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/VEYRA_GOOGLE_SERVICE_ACCOUNT/);
      expect(message).not.toContain('PRIVATE');
    }
    expect(() =>
      parseServiceAccount(
        JSON.stringify({ ...ACCOUNT, private_key: 'PRIVATE KEY that is not a key' }),
      ),
    ).toThrow(/cannot be read/);
  });

  it('understands the links people copy, and nothing else', () => {
    expect(parseSheetLink(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=123`)).toEqual({
      spreadsheetId: ID,
      gid: 123,
    });
    expect(parseSheetLink(`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`)).toEqual(
      { spreadsheetId: ID, gid: null },
    );
    expect(parseSheetLink(ID)).toEqual({ spreadsheetId: ID, gid: null });
    expect(parseSheetLink(`http://docs.google.com/spreadsheets/d/${ID}`)).toBeNull();
    expect(parseSheetLink(`https://evil.example/spreadsheets/d/${ID}`)).toBeNull();
    expect(parseSheetLink('https://docs.google.com/document/d/abc/edit')).toBeNull();
  });
});
