// The Email invoice form's fields and what POST /api/v1/invoices/:id/email takes from them
import { z } from 'zod';

const isEmail = (s: string) => z.string().email().safeParse(s).success;

/** "a@x.com, b@y.com" → ['a@x.com', 'b@y.com'] (blanks and spaces dropped) */
export const ccList = (cc?: string) => (cc ?? '').split(/[,;]/).map(s => s.trim()).filter(Boolean);

export const EmailSchema = z.object({
  to:      z.string().trim().min(1, 'Enter the client’s email address').email('Enter a valid email address').max(200),
  cc:      z.string().max(1000).optional()
    .refine(cc => ccList(cc).every(isEmail), 'One of these isn’t a valid email address')
    .refine(cc => ccList(cc).length <= 5, 'At most 5 CC addresses'),
  subject: z.string().trim().min(1, 'Subject required').max(200).refine(s => !/[\r\n]/.test(s), 'Keep the subject to one line'),
  message: z.string().trim().min(1, 'Message required').max(10_000),
});
export type EmailFormData = z.infer<typeof EmailSchema>;

export function emailBody(data: EmailFormData, idempotencyKey: string) {
  const cc = ccList(data.cc);
  return {
    to: data.to.trim(),
    ...(cc.length ? { cc } : {}),
    subject: data.subject.trim(),
    message: data.message.trim(),
    idempotency_key: idempotencyKey,
  };
}
