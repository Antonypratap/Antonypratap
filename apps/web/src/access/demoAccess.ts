/**
 * Demo access gate. NOT authentication.
 *
 * The product workspace in the demo environment sits behind a fixed demo PIN so a casual visitor
 * of the marketing site does not land in it by accident. There are no users, sessions or server
 * checks: the API stays as open as it is today. Everything about the gate lives in `src/access/`,
 * so real authentication can replace it by swapping this module and `DemoGate`.
 *
 * The PIN is compared by digest so it does not appear in the page source or UI copy. With four
 * digits this hides it from reading, not from guessing, which is all a demo gate needs.
 */

/** Where "See Veyra in action" leads: the workspace, behind the gate. */
export const DEMO_ENTRY_HREF = '#/app/inbox';

const STORAGE_KEY = 'veyra.demoAccess';
const SALT = 'veyra-demo-gate:';
const PIN_DIGEST = 'a4fffa72';

/** FNV-1a (32-bit), hex. Synchronous and dependency-free; works outside secure contexts. */
export function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function isDemoPin(pin: string): boolean {
  return /^\d{4}$/.test(pin) && digest(SALT + pin) === PIN_DIGEST;
}

/** Browser-session scope: survives reloads in this tab; a new tab or browser asks again. */
function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function hasDemoAccess(): boolean {
  try {
    return storage()?.getItem(STORAGE_KEY) === 'granted';
  } catch {
    return false;
  }
}

export function grantDemoAccess(): void {
  try {
    storage()?.setItem(STORAGE_KEY, 'granted');
  } catch {
    // Storage blocked: access still holds for this page view (DemoGate keeps it in state).
  }
}
