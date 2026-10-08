import { createPrivateKey, createSign } from 'node:crypto';
import { MAX_COLUMNS, MAX_ROWS, type Cell, type SheetRow } from '../spreadsheet/xlsx';
import { SheetsError, type SheetsReader } from './sheets';

/**
 * Google Sheets, read-only, as Veyrafy's own service account (docs/SECURITY.md, "Google Sheets").
 * A business shares its register with the service address as Viewer; Veyrafy signs in with the
 * account's key (held as a secret, never logged) for the `spreadsheets.readonly` scope only, so it
 * can read what was shared with it and nothing else, and can never change a sheet. Unsharing the
 * sheet ends the access. No SDK: one signed token request and plain HTTPS reads to two fixed
 * Google hosts.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
/** The last column read: the same 60-column limit as the .xlsx reader (A..BH). */
const LAST_COLUMN = 'BH';
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;

export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
}

/**
 * The service account from its JSON key (as Google downloads it, or base64 of it). Only the two
 * fields used are kept; an invalid key is refused without repeating any of it.
 */
export function parseServiceAccount(raw: string): GoogleServiceAccount {
  const text = raw.trim().startsWith('{')
    ? raw
    : Buffer.from(raw.trim(), 'base64').toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('VEYRA_GOOGLE_SERVICE_ACCOUNT is not a service-account JSON key');
  }
  const o = (json ?? {}) as Record<string, unknown>;
  const email = typeof o.client_email === 'string' ? o.client_email : '';
  const key = typeof o.private_key === 'string' ? o.private_key : '';
  if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(email) || !key.includes('PRIVATE KEY'))
    throw new Error('VEYRA_GOOGLE_SERVICE_ACCOUNT is not a service-account JSON key');
  try {
    createPrivateKey(key);
  } catch {
    throw new Error('VEYRA_GOOGLE_SERVICE_ACCOUNT holds a private key that cannot be read');
  }
  return { client_email: email, private_key: key };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

interface GridValue {
  effectiveValue?: {
    numberValue?: number;
    stringValue?: string;
    boolValue?: boolean;
    errorValue?: { type?: string; message?: string };
  };
  formattedValue?: string;
  effectiveFormat?: { numberFormat?: { type?: string } };
}

const EMPTY: Cell = { text: '', kind: 'empty', format: null, formula: false };

/** A Sheets cell as the .xlsx reader would have returned it. */
function cellOf(v: GridValue | undefined): Cell {
  const e = v?.effectiveValue;
  if (!e) return EMPTY;
  if (e.numberValue !== undefined) {
    const t = v?.effectiveFormat?.numberFormat?.type;
    return {
      text: Number.isFinite(e.numberValue) ? String(e.numberValue) : '',
      kind: 'number',
      format: t === 'DATE' || t === 'DATE_TIME' ? 'date' : t === 'PERCENT' ? 'percent' : null,
      formula: false,
    };
  }
  if (e.stringValue !== undefined)
    return { text: e.stringValue, kind: 'string', format: null, formula: false };
  if (e.boolValue !== undefined)
    return { text: e.boolValue ? 'TRUE' : 'FALSE', kind: 'boolean', format: null, formula: false };
  if (e.errorValue)
    return { text: v?.formattedValue ?? '#ERROR', kind: 'error', format: null, formula: false };
  return EMPTY;
}

export class GoogleSheets implements SheetsReader {
  readonly serviceEmail: string;
  private token: { value: string; until: number } | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly account: GoogleServiceAccount,
    opts: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {},
  ) {
    this.serviceEmail = account.client_email;
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private unavailable(): SheetsError {
    return new SheetsError(
      'Google Sheets is unavailable right now; the last synced records are used. Try again in a few minutes.',
      'unavailable',
    );
  }

  /** An access token for the read-only scope, signed with the service account's key. */
  private async accessToken(): Promise<string> {
    const now = this.now();
    if (this.token && this.token.until > now + 60_000) return this.token.value;
    const iat = Math.floor(now / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({
        iss: this.account.client_email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat,
        exp: iat + 3600,
      }),
    );
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${claims}`)
      .sign(this.account.private_key, 'base64url');
    let res: Response;
    try {
      res = await this.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: `${header}.${claims}.${signature}`,
        }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw this.unavailable();
    }
    if (!res.ok)
      throw new SheetsError(
        res.status >= 500
          ? 'Google Sheets is unavailable right now; the last synced records are used. Try again in a few minutes.'
          : "Veyrafy couldn't sign in to Google Sheets. Ask Veyrafy support to check the Google connection.",
        res.status >= 500 ? 'unavailable' : 'invalid',
      );
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw this.unavailable();
    this.token = { value: body.access_token, until: now + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  private async get(url: string): Promise<unknown> {
    const token = await this.accessToken();
    let res: Response;
    try {
      res = await this.fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw this.unavailable();
    }
    if (res.status === 401) this.token = null;
    if (res.status === 403 || res.status === 401)
      throw new SheetsError(
        `Veyrafy can't open this sheet. Share it with ${this.serviceEmail} as Viewer, then try again.`,
        'not_shared',
      );
    if (res.status === 404)
      throw new SheetsError("This link doesn't open a Google Sheet. Check the link.", 'not_found');
    if (res.status === 400)
      throw new SheetsError(
        "This file can't be read as a Google Sheet. If it is an Excel file stored in Drive, open it and choose File › Save as Google Sheets, or upload the Excel file instead.",
        'invalid',
      );
    if (!res.ok) throw this.unavailable();
    const length = Number(res.headers.get('content-length') ?? '0');
    if (length > MAX_RESPONSE_BYTES)
      throw new SheetsError(
        'This sheet is too large to read. Keep the register to the invoices being checked.',
        'too_large',
      );
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES)
      throw new SheetsError(
        'This sheet is too large to read. Keep the register to the invoices being checked.',
        'too_large',
      );
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw this.unavailable();
    }
  }

  async open(spreadsheetId: string) {
    const body = (await this.get(
      `${SHEETS}/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent('properties.title,sheets.properties(title,sheetId)')}`,
    )) as {
      properties?: { title?: string };
      sheets?: { properties?: { title?: string; sheetId?: number } }[];
    };
    return {
      title: body.properties?.title ?? 'Google Sheet',
      tabs: (body.sheets ?? [])
        .map((s) => ({ title: s.properties?.title ?? '', gid: s.properties?.sheetId ?? 0 }))
        .filter((s) => s.title !== ''),
    };
  }

  async readTab(spreadsheetId: string, tabTitle: string): Promise<SheetRow[]> {
    // One more row than the limit, so a sheet over it is refused rather than cut short.
    const range = `'${tabTitle.replace(/'/g, "''")}'!A1:${LAST_COLUMN}${MAX_ROWS + 1}`;
    const fields =
      'sheets.data.rowData.values(effectiveValue,formattedValue,effectiveFormat.numberFormat.type)';
    const body = (await this.get(
      `${SHEETS}/${encodeURIComponent(spreadsheetId)}?includeGridData=true&ranges=${encodeURIComponent(range)}&fields=${encodeURIComponent(fields)}`,
    )) as { sheets?: { data?: { rowData?: { values?: GridValue[] }[] }[] }[] };
    const rowData = body.sheets?.[0]?.data?.[0]?.rowData ?? [];
    const rows: SheetRow[] = [];
    rowData.forEach((r, i) => {
      const cells = (r.values ?? []).slice(0, MAX_COLUMNS).map(cellOf);
      while (cells.length && cells[cells.length - 1]?.kind === 'empty') cells.pop();
      if (cells.length) rows.push({ rowNumber: i + 1, cells });
    });
    if (rows.length > MAX_ROWS)
      throw new SheetsError(
        `“${tabTitle}” has more than ${MAX_ROWS} rows. Keep the register to the invoices being checked.`,
        'too_large',
      );
    return rows;
  }
}
