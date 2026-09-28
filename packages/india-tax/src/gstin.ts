import { z } from 'zod';
import { err, ok, type Result, type StateCode } from '@veyra/shared';
import { isGstStateCode } from './states';

const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** RULES §1.4 GSTIN format. */
const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_FORMAT = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export type Gstin = string & z.$brand<'Gstin'>;
export type Pan = string & z.$brand<'Pan'>;

export type GstinErrorCode =
  'empty' | 'bad_length' | 'bad_format' | 'unknown_state_code' | 'bad_checksum';
export interface GstinError {
  code: GstinErrorCode;
  message: string;
  /** For `bad_checksum`: the check character the first 14 characters require. */
  expectedCheckChar?: string;
}

export interface ParsedGstin {
  gstin: Gstin;
  stateCode: StateCode;
  pan: Pan;
  /** 13th character: entity number for the same PAN within the state. */
  entityCode: string;
  checkChar: string;
}

/** Mod-36 check character for the first 14 characters of a GSTIN. */
export function computeGstinCheckChar(first14: string): string {
  if (!/^[0-9A-Z]{14}$/.test(first14)) throw new RangeError('expected 14 characters of [0-9A-Z]');
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = CHARSET.indexOf(first14.charAt(i)) * (i % 2 === 0 ? 1 : 2);
    sum += Math.trunc(product / 36) + (product % 36);
  }
  return CHARSET.charAt((36 - (sum % 36)) % 36);
}

/**
 * Validates a GSTIN: length, format, state code, checksum (in that order).
 * Only surrounding whitespace is trimmed and letters uppercased; nothing else is corrected.
 */
export function validateGstin(input: string): Result<ParsedGstin, GstinError> {
  const value = input.trim().toUpperCase();
  if (value === '') return err({ code: 'empty', message: 'GSTIN is empty' });
  if (value.length !== 15)
    return err({ code: 'bad_length', message: `GSTIN must be 15 characters, got ${value.length}` });
  if (!GSTIN_FORMAT.test(value))
    return err({ code: 'bad_format', message: 'GSTIN does not match the GSTIN format' });
  const stateCode = value.slice(0, 2);
  if (!isGstStateCode(stateCode)) {
    return err({ code: 'unknown_state_code', message: `unknown GST state code ${stateCode}` });
  }
  const expected = computeGstinCheckChar(value.slice(0, 14));
  if (value.charAt(14) !== expected) {
    return err({
      code: 'bad_checksum',
      message: 'GSTIN checksum does not match',
      expectedCheckChar: expected,
    });
  }
  return ok({
    gstin: value as Gstin,
    stateCode,
    pan: value.slice(2, 12) as Pan,
    entityCode: value.charAt(12),
    checkChar: value.charAt(14),
  });
}

export function isValidGstin(input: string): boolean {
  return validateGstin(input).ok;
}

export const GstinSchema = z
  .string()
  .refine((v) => v === v.trim().toUpperCase() && isValidGstin(v), 'invalid GSTIN')
  .transform((v) => v as Gstin);

export function isValidPan(input: string): input is Pan {
  return PAN_FORMAT.test(input);
}

export const PanSchema = z
  .string()
  .refine(isValidPan, 'invalid PAN')
  .transform((v) => v as Pan);
