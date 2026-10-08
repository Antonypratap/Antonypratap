import type { SheetRow } from '../spreadsheet/xlsx';

/**
 * Reading a Google Sheet, as the data sources need it (the implementation is ./google.ts; tests
 * use a fake). Read-only: nothing here can change a sheet.
 */
export interface SheetsReader {
  /** The address a person shares their sheet with (Viewer). */
  readonly serviceEmail: string;
  /** The spreadsheet's title and its tabs. */
  open(spreadsheetId: string): Promise<{ title: string; tabs: { title: string; gid: number }[] }>;
  /** One tab's rows, as the .xlsx reader returns them. */
  readTab(spreadsheetId: string, tabTitle: string): Promise<SheetRow[]>;
}

/** A Google Sheets failure, worded for the person (what happened, and what to do). */
export class SheetsError extends Error {
  constructor(
    message: string,
    readonly reason: 'not_shared' | 'not_found' | 'unavailable' | 'too_large' | 'invalid',
  ) {
    super(message);
    this.name = 'SheetsError';
  }
}

/**
 * The spreadsheet id (and tab, from `#gid=`) of a link as copied from the browser, or of a bare
 * id. Null when it is not a Google Sheets link.
 */
export function parseSheetLink(link: string): { spreadsheetId: string; gid: number | null } | null {
  const text = link.trim();
  const bare = /^[A-Za-z0-9_-]{25,100}$/.exec(text);
  if (bare) return { spreadsheetId: text, gid: null };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') return null;
  const id = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{25,100})(?:\/|$)/.exec(url.pathname)?.[1];
  if (!id) return null;
  const gid = /(?:^|[#&?])gid=(\d{1,12})/.exec(`${url.hash}&${url.search}`)?.[1];
  return { spreadsheetId: id, gid: gid === undefined ? null : Number(gid) };
}
