// Razorpay webhook: Dashboard -> Webhooks -> https://<your-domain>/api/payments/razorpay/webhook with events
// payment.captured, payment.failed and refund.processed, and its secret in RAZORPAY_WEBHOOK_SECRET.
// A web-standard handler, because the signature is checked against the exact bytes Razorpay sent.
import { handleWebhook } from './_payments.mjs';

export async function POST(request) {
  const raw = await request.text();
  const { status, body } = await handleWebhook(raw, request.headers.get('x-razorpay-signature') || '');
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
