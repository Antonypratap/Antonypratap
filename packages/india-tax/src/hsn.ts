/** HSN/SAC codes are 4, 6 or 8 digits (RULES §1.4). */
export function isValidHsnSac(code: string): boolean {
  return /^(\d{4}|\d{6}|\d{8})$/.test(code);
}
