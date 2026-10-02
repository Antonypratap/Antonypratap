import { describe, expect, it } from 'vitest';
import { carriesFiles, pastedName, refusalOf } from './files';

describe('upload file checks', () => {
  it('accepts PDFs, JPEGs and PNGs by type or by extension', () => {
    expect(refusalOf({ name: 'a.pdf', type: 'application/pdf', size: 10 })).toBeNull();
    expect(refusalOf({ name: 'photo.JPG', type: '', size: 10 })).toBeNull();
    expect(refusalOf({ name: 'scan', type: 'image/png', size: 10 })).toBeNull();
  });

  it('refuses other files, empty files and files over the limit, in plain words', () => {
    expect(refusalOf({ name: 'a.docx', type: 'application/msword', size: 10 })).toBe(
      'Only PDF, JPEG or PNG invoices, or an ERP receipt file, can be read.',
    );
    expect(refusalOf({ name: 'photo.heic', type: 'image/heic', size: 10 })).toBe(
      'Only PDF, JPEG or PNG invoices, or an ERP receipt file, can be read.',
    );
    // An ERP goods-receipt export (often saved as .txt) is accepted: it is imported instead.
    expect(refusalOf({ name: 'GRN_857.txt', type: 'text/plain', size: 10 })).toBeNull();
    expect(refusalOf({ name: 'grn.json', type: 'application/json', size: 10 })).toBeNull();
    expect(refusalOf({ name: 'a.pdf', type: 'application/pdf', size: 0 })).toBe(
      'The file is empty.',
    );
    expect(refusalOf({ name: 'a.pdf', type: 'application/pdf', size: 3_000_000 }, 2_097_152)).toBe(
      'The file is larger than 2 MB.',
    );
  });

  it('names pasted images by when they were pasted', () => {
    expect(pastedName('image/png', new Date(2026, 9, 1, 9, 5, 7))).toBe(
      'Pasted invoice 2026-10-01 09.05.07.png',
    );
    expect(pastedName('image/jpeg', new Date(2026, 0, 2, 13, 0, 0))).toBe(
      'Pasted invoice 2026-01-02 13.00.00.jpg',
    );
  });

  it('reacts only to drags that carry files', () => {
    expect(carriesFiles(['Files'])).toBe(true);
    expect(carriesFiles(['text/plain', 'text/uri-list'])).toBe(false);
    expect(carriesFiles(undefined)).toBe(false);
  });
});
