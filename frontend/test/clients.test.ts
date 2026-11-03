import { describe, expect, it } from 'vitest';
import { ClientSchema, clientBody, clientLabel, startingClient } from '@/lib/clients';

describe('clientBody', () => {
  it('sends empty boxes as null and trims what was typed', () => {
    expect(clientBody({
      name: '  Jane Smith ', company_name: ' ', email: '', phone: undefined,
      address: '  12 Mill Lane\nLeeds  ', tax_id: '', notes: '',
    })).toEqual({
      name: 'Jane Smith', company_name: null, email: null, phone: null,
      address: '12 Mill Lane\nLeeds', tax_id: null, notes: null, vat_treatment: 'standard',
    });
  });

  it('keeps the company and the other details', () => {
    expect(clientBody({
      name: 'Jane Smith', company_name: 'Smith Joinery Ltd', email: 'jane@example.com',
      phone: '0113 496 0000', tax_id: 'GB123456789', notes: 'Pays by BACS',
    })).toMatchObject({
      company_name: 'Smith Joinery Ltd', email: 'jane@example.com', phone: '0113 496 0000',
      tax_id: 'GB123456789', notes: 'Pays by BACS',
    });
  });

  it('turns the outside-the-UK box into the VAT treatment', () => {
    expect(clientBody({ name: 'Acme GmbH', overseas: true }).vat_treatment).toBe('outside_scope');
    expect(clientBody({ name: 'Acme Ltd', overseas: false }).vat_treatment).toBe('standard');
    expect(clientBody({ name: 'Acme Ltd' }).vat_treatment).toBe('standard');
  });
});

describe('ClientSchema', () => {
  const ok = (data: unknown) => ClientSchema.safeParse(data).success;

  it('needs a name, and spaces alone don’t count', () => {
    expect(ok({ name: 'Jane' })).toBe(true);
    expect(ok({ name: '' })).toBe(false);
    expect(ok({ name: '   ' })).toBe(false);
  });

  it('leaves company, address and email optional, but checks an email that is typed', () => {
    expect(ok({ name: 'Jane', company_name: '', address: '', email: '' })).toBe(true);
    expect(ok({ name: 'Jane', email: 'jane@example.com' })).toBe(true);
    expect(ok({ name: 'Jane', email: 'not an email' })).toBe(false);
  });

  it('keeps to the limits the API sets', () => {
    expect(ok({ name: 'Jane', company_name: 'x'.repeat(200) })).toBe(true);
    expect(ok({ name: 'Jane', company_name: 'x'.repeat(201) })).toBe(false);
    expect(ok({ name: 'Jane', address: 'x'.repeat(501) })).toBe(false);
    expect(ok({ name: 'Jane', phone: '0'.repeat(31) })).toBe(false);
  });

  it('says which limit a box is over', () => {
    const res = ClientSchema.safeParse({ name: 'Jane', phone: '0'.repeat(31), company_name: 'x'.repeat(201) });
    expect(res.success).toBe(false);
    const messages = Object.fromEntries(res.error!.issues.map(i => [i.path[0], i.message]));
    expect(messages).toEqual({
      phone: 'Keep this to 30 characters or fewer',
      company_name: 'Keep this to 200 characters or fewer',
    });
  });
});

describe('clientLabel', () => {
  it('adds the company after the name, so people with the same name can be told apart', () => {
    expect(clientLabel({ name: 'John Smith', company_name: 'Acme Ltd' })).toBe('John Smith — Acme Ltd');
    expect(clientLabel({ name: 'John Smith', company_name: null })).toBe('John Smith');
    expect(clientLabel({ name: 'Acme Ltd' })).toBe('Acme Ltd');
  });
});

describe('startingClient', () => {
  const active = [{ id: 'a' }, { id: 'b' }];

  it('keeps a client that is still active', () => {
    expect(startingClient('b', active)).toBe('b');
  });

  it('starts empty for a deactivated (or unknown) client, so one has to be chosen', () => {
    expect(startingClient('gone', active)).toBe('');
    expect(startingClient('', active)).toBe('');
  });
});
