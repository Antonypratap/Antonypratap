import { inspect } from 'node:util';

/**
 * A configuration secret (Phase 6C): the database URL, and later ERP credentials. Printing,
 * logging or serialising it gives "[secret]"; only `reveal()` returns the value, and only the code
 * that must use it (the database pool, the ERP connector) calls it.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[secret]';
  }

  toJSON(): string {
    return '[secret]';
  }

  [inspect.custom](): string {
    return '[secret]';
  }
}
