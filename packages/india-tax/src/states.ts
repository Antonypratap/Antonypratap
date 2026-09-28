import type { StateCode } from '@veyra/shared';
import { err, ok, type Result } from '@veyra/shared';

/**
 * GST state / UT codes as published on the GST portal. A code is valid exactly when it is in
 * this table. `alternateNames` are former official names still seen on invoices; no fuzzy matching.
 */
export const GST_STATES = [
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand', alternateNames: ['Uttaranchal'] },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi', alternateNames: ['National Capital Territory of Delhi'] },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha', alternateNames: ['Orissa'] },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '25', name: 'Daman and Diu' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '28', name: 'Andhra Pradesh (Before Division)' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry', alternateNames: ['Pondicherry'] },
  { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
  { code: '97', name: 'Other Territory' },
  { code: '99', name: 'Centre Jurisdiction' },
] as const satisfies readonly { code: string; name: string; alternateNames?: readonly string[] }[];

const BY_CODE = new Map<string, string>(GST_STATES.map((s) => [s.code, s.name]));

const normalizeStateName = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll('&', ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const BY_NAME = new Map<string, StateCode>();
for (const s of GST_STATES) {
  const names: readonly string[] = [s.name, ...('alternateNames' in s ? s.alternateNames : [])];
  for (const name of names) BY_NAME.set(normalizeStateName(name), s.code as StateCode);
}

export function isGstStateCode(code: string): code is StateCode {
  return BY_CODE.has(code);
}

export function stateName(code: StateCode): string | undefined {
  return BY_CODE.get(code);
}

export type StateResolutionError =
  'empty' | 'unknown_state' | 'multiple_codes' | 'code_name_mismatch';

/**
 * Resolves printed state text to a GST state code. Accepts a code ("29"), a name ("Karnataka"),
 * or both ("Karnataka (29)", "29-Karnataka", "Karnataka, State Code: 29"). When both are present
 * they must agree. Unknown names are an error: there is no fuzzy matching.
 */
export function resolveStateCode(text: string): Result<StateCode, StateResolutionError> {
  if (text.trim() === '') return err('empty');
  const codes = [...new Set(text.match(/\b\d{2}\b/g) ?? [])];
  if (codes.length > 1) return err('multiple_codes');
  const namePart = normalizeStateName(
    text
      .replace(/\b\d{2}\b/g, ' ')
      .replace(/\b(place\s+of\s+supply|state\s+code|state|code|pos)\b/gi, ' '),
  );
  const code = codes[0];
  const fromName = namePart === '' ? undefined : BY_NAME.get(namePart);
  if (namePart !== '' && fromName === undefined) return err('unknown_state');
  if (code !== undefined && !isGstStateCode(code)) return err('unknown_state');
  if (code !== undefined && fromName !== undefined && code !== fromName)
    return err('code_name_mismatch');
  const resolved = fromName ?? code;
  return resolved === undefined ? err('unknown_state') : ok(resolved as StateCode);
}
