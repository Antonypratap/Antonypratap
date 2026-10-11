import { formatInr, paise, type Paise } from '@veyra/shared';

export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning.';
  if (hour >= 12 && hour < 17) return 'Good afternoon.';
  return 'Good evening.';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-22" → "22 Sep 2026" */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1] ?? ''} ${y}`;
}

/** Calendar parts of an instant in India Standard Time, the time every screen and export uses. */
function istParts(iso: string): { y: number; m: number; d: number; hh: number; mm: number } {
  const ist = new Date(new Date(iso).getTime() + 330 * 60_000);
  return {
    y: ist.getUTCFullYear(),
    m: ist.getUTCMonth() + 1,
    d: ist.getUTCDate(),
    hh: ist.getUTCHours(),
    mm: ist.getUTCMinutes(),
  };
}

function clock(hh: number, mm: number): string {
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`;
}

/** "2026-10-09T08:44:00Z" → "9 Oct 2026, 2:14 pm" (IST) */
export function formatDateTime(iso: string): string {
  const p = istParts(iso);
  return `${p.d} ${MONTHS[p.m - 1] ?? ''} ${p.y}, ${clock(p.hh, p.mm)}`;
}

/** How long ago, for lists: "just now", "12 min ago", "3 h ago", "yesterday", then the date (IST). */
export function formatRelative(iso: string, now: Date): string {
  const seconds = Math.floor((now.getTime() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} min ago`;
  const then = istParts(iso);
  const today = istParts(now.toISOString());
  const dayNo = (p: { y: number; m: number; d: number }) =>
    Date.UTC(p.y, p.m - 1, p.d) / 86_400_000;
  const days = dayNo(today) - dayNo(then);
  if (days === 0) return `${String(Math.floor(seconds / 3600))} h ago`;
  if (days === 1) return 'yesterday';
  return `${then.d} ${MONTHS[then.m - 1] ?? ''} ${then.y}`;
}

export const inr = (p: Paise | number): string => formatInr(paise(p));

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const t = TENS[Math.floor(n / 10)] ?? '';
  return n % 10 ? `${t} ${ONES[n % 10]}` : t;
}

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? below100(r) : ''].filter(Boolean).join(' ');
}

/** Indian-system amount in words, as printed on GST invoices: "Rupees Fourteen Thousand … Only". */
export function amountInWords(p: Paise | number): string {
  const total = Number(p);
  const rupees = Math.floor(total / 100);
  const paisepart = total % 100;
  const parts: string[] = [];
  const crore = Math.floor(rupees / 10_000_000);
  const lakh = Math.floor((rupees % 10_000_000) / 100_000);
  const thousand = Math.floor((rupees % 100_000) / 1000);
  const rest = rupees % 1000;
  if (crore) parts.push(`${below1000(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (rest) parts.push(below1000(rest));
  const words = parts.length ? parts.join(' ') : 'Zero';
  return `Rupees ${words}${paiseparts(paisepart)} Only`;
}

const paiseparts = (p: number): string => (p ? ` and ${below100(p)} Paise` : '');
