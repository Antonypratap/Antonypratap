import { hash, verify, type Options } from '@node-rs/argon2';

/**
 * Password hashing (Phase 6C): Argon2id with the OWASP-recommended baseline (19 MiB memory,
 * 2 iterations, 1 lane), stored as a PHC string that carries its own parameters and salt.
 * Nothing here is invented: the algorithm and its implementation are standard.
 */
const PARAMS: Options = {
  algorithm: 2, // Algorithm.Argon2id (a const enum, which isolated modules cannot import)
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export const PASSWORD_MIN = 12;
/** Upper bound so a huge "password" cannot be used to burn CPU. */
export const PASSWORD_MAX = 256;

/** Length only (NIST SP 800-63B): no composition rules. Returns a problem, or null. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMS);
}

/** A hash of a random string, verified when an account does not exist, so timing tells nothing. */
let dummy: Promise<string> | null = null;

/**
 * Checks a password against a stored hash. With no hash (unknown or password-less account) the
 * same amount of work is done against a dummy hash and the answer is false.
 */
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  if (password.length > PASSWORD_MAX) return false;
  dummy ??= hash(`dummy-${Math.random()}`, PARAMS);
  const target = stored ?? (await dummy);
  try {
    const ok = await verify(target, password);
    return stored !== null && ok;
  } catch {
    return false;
  }
}
