import { describe, expect, it } from 'vitest';
import { ccList, EmailSchema, emailBody } from '@/lib/invoiceEmail';

const form = { to: 'jane@example.com', cc: '', subject: 'Your invoice', message: 'Hello' };
const ok = (over: Record<string, unknown>) => EmailSchema.safeParse({ ...form, ...over }).success;

describe('ccList', () => {
  it('splits on commas or semicolons and drops blanks', () => {
    expect(ccList(' a@x.co, b@y.co ;c@z.co,, ')).toEqual(['a@x.co', 'b@y.co', 'c@z.co']);
    expect(ccList('')).toEqual([]);
    expect(ccList(undefined)).toEqual([]);
  });
});

describe('EmailSchema', () => {
  it('accepts a filled-in form, with or without CC', () => {
    expect(ok({})).toBe(true);
    expect(ok({ cc: 'a@x.co, b@y.co' })).toBe(true);
  });

  it('needs a valid To address', () => {
    expect(ok({ to: '' })).toBe(false);
    expect(ok({ to: 'jane' })).toBe(false);
  });

  it('checks every CC address, and allows at most five', () => {
    expect(ok({ cc: 'a@x.co, nope' })).toBe(false);
    expect(ok({ cc: Array(5).fill('a@x.co').join(',') })).toBe(true);
    expect(ok({ cc: Array(6).fill('a@x.co').join(',') })).toBe(false);
  });

  it('keeps the subject to one line and needs a message', () => {
    expect(ok({ subject: 'Hi\nBcc: x@y.z' })).toBe(false);
    expect(ok({ subject: '  ' })).toBe(false);
    expect(ok({ message: '  ' })).toBe(false);
  });
});

describe('emailBody', () => {
  it('trims the fields, sends CC as a list, and leaves it out when empty', () => {
    expect(emailBody({ to: ' jane@example.com ', cc: 'a@x.co; b@y.co', subject: ' Hi ', message: ' Hello \n' }, 'key-1234'))
      .toEqual({ to: 'jane@example.com', cc: ['a@x.co', 'b@y.co'], subject: 'Hi', message: 'Hello', idempotency_key: 'key-1234' });
    expect(emailBody(form, 'key-1234')).not.toHaveProperty('cc');
  });
});
