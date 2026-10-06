import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LEGAL, legalComplete, legalPageOf } from './legal';
import { PrivacyNotice, TermsOfUse } from './LegalPages';

describe('privacy notice and terms', () => {
  it('are at /privacy and /terms', () => {
    expect(legalPageOf('/privacy')).toBe('privacy');
    expect(legalPageOf('/terms/')).toBe('terms');
    expect(legalPageOf('/')).toBeNull();
  });

  it('say what the challenge keeps, for how long, and who processes it', () => {
    const html = renderToStaticMarkup(createElement(PrivacyNotice));
    expect(html).toContain(
      'deleted 24\n          hours after you see your full results'.replace(/\s+/g, ' '),
    );
    for (const text of [
      'Google Gemini',
      'veyra_challenge_used',
      'Digital Personal Data Protection Act, 2023',
      'Data Protection Board of India',
      'Railway',
      'Resend',
    ])
      expect(html).toContain(text);
  });

  it('say they are a draft until the legal details are confirmed (never invented)', () => {
    const privacy = renderToStaticMarkup(createElement(PrivacyNotice));
    const terms = renderToStaticMarkup(createElement(TermsOfUse));
    if (legalComplete()) {
      expect(privacy).not.toContain('Draft');
      expect(privacy).toContain(LEGAL.entity ?? '');
    } else {
      expect(privacy).toContain('Draft: the legal details of this text are being confirmed.');
      expect(terms).toContain('Draft: the legal details of this text are being confirmed.');
    }
    expect(terms).toContain('authorised by your company');
  });
});
