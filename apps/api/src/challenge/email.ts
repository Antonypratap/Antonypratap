import { FINDING_TYPE_LABEL, formatInr, paise, type ApiChallengeSummary } from '@veyra/shared';

/**
 * Outbound e-mail (the 10 Invoice Challenge follow-up). Veyrafy only sends: there is no inbox.
 * The result is what actually happened, recorded as such; an unconfigured sender never claims a
 * message was sent.
 */
export type EmailResult = 'sent' | 'failed' | 'not_configured';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  readonly configured: boolean;
  send(message: EmailMessage): Promise<EmailResult>;
}

/** No provider configured: nothing is sent, and that is what is recorded. */
export const noEmail: EmailSender = {
  configured: false,
  send: () => Promise.resolve('not_configured'),
};

/**
 * Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email). The key comes
 * from the environment and is never logged.
 */
export class ResendEmailSender implements EmailSender {
  readonly configured = true;

  constructor(
    private readonly o: {
      apiKey: string;
      from: string;
      fetch?: typeof globalThis.fetch;
      log?: { warn(obj: object, msg: string): void };
    },
  ) {}

  async send(m: EmailMessage): Promise<EmailResult> {
    try {
      const res = await (this.o.fetch ?? globalThis.fetch)('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.o.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.o.from,
          to: [m.to],
          subject: m.subject,
          text: m.text,
          ...(m.html ? { html: m.html } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return 'sent';
      this.o.log?.warn({ status: res.status }, 'e-mail not accepted by the provider');
      return 'failed';
    } catch (e) {
      this.o.log?.warn({ reason: e instanceof Error ? e.name : 'unknown' }, 'e-mail not sent');
      return 'failed';
    }
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The completion e-mail to the prospect: the findings in brief, the link, the next step. */
export function challengeEmail(i: {
  company: string;
  contactName: string | null;
  summary: ApiChallengeSummary;
  link: string | null;
  bookingUrl: string | null;
}): { subject: string; text: string; html: string } {
  const s = i.summary;
  const money = (p: number) => formatInr(paise(p));
  const types = Object.entries(s.byType)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${FINDING_TYPE_LABEL[k] ?? k}: ${n}`);
  const lines = [
    `${s.checked} invoice${s.checked === 1 ? '' : 's'} checked`,
    `${s.cleared} cleared`,
    `${s.attention} need${s.attention === 1 ? 's' : ''} attention`,
    `${money(s.reviewValuePaise)} of invoice value requires review`,
  ];
  const hello = i.contactName ? `Hello ${i.contactName},` : 'Hello,';
  const subject = `Your Veyrafy Invoice Verification Report: ${i.company}`;
  const text = [
    hello,
    '',
    `Your 10 Invoice Challenge for ${i.company} is complete.`,
    '',
    ...lines.map((l) => `  • ${l}`),
    ...(types.length ? ['', 'What needs attention:', ...types.map((t) => `  • ${t}`)] : []),
    '',
    i.link
      ? `See every finding with its evidence, and download the report: ${i.link}\n(This link is private to you: please don't forward it. Forward the report instead.)`
      : 'Open the challenge in the browser you used to see every finding and download the report.',
    '',
    'Want Veyrafy to check every invoice before payment? Book a 15-minute walkthrough:',
    i.bookingUrl ?? 'reply to this e-mail and we will set it up.',
    '',
    'Veyrafy',
  ].join('\n');
  const html = `<div style="font-family:Inter,Arial,sans-serif;color:#0d0f12;max-width:560px;line-height:1.5">
<p>${esc(hello)}</p>
<p>Your 10 Invoice Challenge for <strong>${esc(i.company)}</strong> is complete.</p>
<table style="border-collapse:collapse;margin:12px 0">${lines
    .map(
      (l, n) =>
        `<tr><td style="padding:4px 0;${n === 3 ? 'font-weight:600;color:#9a5a0b' : ''}">${esc(l)}</td></tr>`,
    )
    .join('')}</table>
${types.length ? `<p style="margin:12px 0 4px;font-weight:600">What needs attention</p><ul style="margin:0;padding-left:18px">${types.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
${i.link ? `<p style="margin:20px 0"><a href="${esc(i.link)}" style="background:#0d0f12;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">See the findings and download the report</a></p><p style="font-size:12px;color:#6b7079">This link is private to you: please don't forward it. Forward the report instead.</p>` : ''}
<p style="margin-top:24px">Want Veyrafy to check every invoice before payment?</p>
<p>${i.bookingUrl ? `<a href="${esc(i.bookingUrl)}">Book a 15-minute walkthrough</a>` : 'Reply to this e-mail to book a 15-minute walkthrough.'}</p>
<p style="color:#6b7079;font-size:12px;margin-top:24px">Veyrafy · Invoice verification before payment</p>
</div>`;
  return { subject, text, html };
}
