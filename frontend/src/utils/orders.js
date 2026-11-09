const ONLINE_STATUS = { paid: 'Paid', refunded: 'Refunded', refund_pending: 'Refund in progress', processing: 'Confirming payment' };

// Payment status in plain words. Online payments report their own status; cash depends on where the order is.
export function paymentStatus(order, delivered) {
  if (order.payment_status) return ONLINE_STATUS[order.payment_status] || order.payment_status;
  if (order.payment_method !== 'cod') return 'Paid';
  if (order.status === 'cancelled') return 'Not charged';
  if (order.status === 'returned') return order.return_refund === 'refunded' || order.return?.refund === 'refunded' ? 'Refunded' : 'Refund in progress';
  return delivered ? 'Paid on delivery' : 'Pay on delivery';
}
