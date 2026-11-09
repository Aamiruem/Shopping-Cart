// Returns and refunds in plain words, shared by the shopper's order page and the Seller Hub (see api/_returns.mjs)
import { formatPrice } from './format';

export const RETURN_WINDOW_DAYS = 7;

export const RETURN_REASONS = [
  ['damaged', 'Damaged or defective'],
  ['wrong_item', 'Wrong item delivered'],
  ['missing', 'Missing parts or items'],
  ['not_as_described', 'Not as described'],
  ['size_fit', 'Size or fit issue'],
  ['quality', 'Quality not as expected'],
  ['not_needed', 'No longer needed'],
  ['other', 'Other reason'],
];

export const RETURN_STEPS = ['Requested', 'Approved', 'Picked up', 'Refunded'];

/** How far along the return is, as an index into RETURN_STEPS. */
export function returnStep(r) {
  if (r.refund === 'refunded') return 3;
  if (r.status === 'received') return 2;
  if (r.status === 'approved') return 1;
  return 0;
}

/** Where the refund goes, e.g. "your original payment method" or "UPI ID asha@okhdfcbank". */
export function refundDestination(r) {
  if (r.refund_to === 'original') return 'your original payment method';
  if (r.refund_to === 'upi') return `UPI ID ${r.refund_upi}`;
  if (r.refund_bank) return `bank account ••••${r.refund_bank.last4} (${r.refund_bank.ifsc})`;
  return 'your bank account';
}

/** One sentence for the shopper about where their return and their money are. */
export function returnMessage(r) {
  const amount = r.amount ? formatPrice(r.amount) : 'Your refund';
  const to = refundDestination(r);
  if (r.status === 'rejected') return `This return wasn’t approved${r.note ? `: ${r.note}` : '.'}`;
  if (r.status === 'requested') return `We’ve received your return request and will reply within 24 hours. ${amount} will be refunded to ${to} once the item is picked up.`;
  if (r.status === 'approved') return `Return approved. Our courier will pick the item up in 2–3 days; please keep it packed with its tags. ${amount} goes to ${to} after pickup.`;
  if (r.refund === 'refunded') return `${amount} has been refunded to ${to}${r.refund_reference ? ` (reference ${r.refund_reference})` : ''}. Banks usually show it within 5–7 working days.`;
  if (r.refund === 'cod_manual') return `Item picked up. ${amount} will be sent to ${to} within 2 working days.`;
  return `Item picked up. Your refund of ${amount} to ${to} is being processed.`;
}
