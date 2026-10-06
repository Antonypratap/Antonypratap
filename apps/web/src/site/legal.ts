/**
 * The facts the privacy notice and terms name. Each one must be confirmed by Veyrafy before the
 * pages are final: while any is null, the pages say they are a draft (they never invent one).
 */
export const LEGAL: {
  /** The registered legal name of the business behind Veyrafy. */
  entity: string | null;
  /** Its registered address. */
  address: string | null;
  /** Where privacy requests and grievances go (the grievance officer's e-mail). */
  privacyEmail: string | null;
  /** The city whose courts the terms name. */
  jurisdiction: string | null;
  /** When the texts were last changed (ISO date). */
  updated: string;
} = {
  entity: null,
  address: null,
  privacyEmail: null,
  jurisdiction: null,
  updated: '2026-10-06',
};

export const legalComplete = (): boolean =>
  LEGAL.entity !== null &&
  LEGAL.address !== null &&
  LEGAL.privacyEmail !== null &&
  LEGAL.jurisdiction !== null;

export type LegalPage = 'privacy' | 'terms';
export const LEGAL_PATHS: Record<LegalPage, string> = {
  privacy: '/privacy',
  terms: '/terms',
};

/** Which legal page an address is, if any. */
export function legalPageOf(pathname: string): LegalPage | null {
  const p = pathname.replace(/\/+$/, '');
  if (p === LEGAL_PATHS.privacy) return 'privacy';
  if (p === LEGAL_PATHS.terms) return 'terms';
  return null;
}
