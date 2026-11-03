// The client form's fields and what the clients API takes from them
import { z } from 'zod';

/** The longest each box may be (the API's limits) */
export const CLIENT_LIMITS = { name: 200, company_name: 200, phone: 30, address: 500, tax_id: 50, notes: 1000 } as const;

const upTo = (n: number) => z.string().max(n, `Keep this to ${n} characters or fewer`);

export const ClientSchema = z.object({
  name:         z.string().trim().min(1, 'Name required').max(CLIENT_LIMITS.name, `Keep this to ${CLIENT_LIMITS.name} characters or fewer`),
  company_name: upTo(CLIENT_LIMITS.company_name).optional(),
  email:        z.string().email('Valid email required').or(z.literal('')).optional(),
  phone:        upTo(CLIENT_LIMITS.phone).optional(),
  address:      upTo(CLIENT_LIMITS.address).optional(),
  tax_id:       upTo(CLIENT_LIMITS.tax_id).optional(),
  notes:        upTo(CLIENT_LIMITS.notes).optional(),
  overseas:     z.boolean().optional(),
});
export type ClientFormData = z.infer<typeof ClientSchema>;

/** What the clients API takes: empty boxes become null, and the `overseas` checkbox becomes vat_treatment. */
export function clientBody(data: ClientFormData) {
  const blank = (v?: string) => v?.trim() || null;
  return {
    name: data.name.trim(),
    company_name: blank(data.company_name),
    email: blank(data.email),
    phone: blank(data.phone),
    address: blank(data.address),
    tax_id: blank(data.tax_id),
    notes: blank(data.notes),
    vat_treatment: data.overseas ? 'outside_scope' : 'standard',
  };
}

/** 'Jane Smith — Smith Joinery Ltd', so people with the same name at different companies can be told apart */
export const clientLabel = (c: { name: string; company_name?: string | null }) =>
  c.company_name ? `${c.name} — ${c.company_name}` : c.name;

/** The client a form can start with: `id` when it is in the (active) list, else none to choose */
export const startingClient = (id: string, clients: Array<{ id: string }>) =>
  clients.some(c => c.id === id) ? id : '';
