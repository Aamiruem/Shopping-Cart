// What the checkout page can offer. No dependencies, so the catalog function can answer without loading the
// payment code. Online payment switches on once both Razorpay keys are set in the deployment's environment.
export function paymentsConfig(env = process.env) {
  // PAYMENTS_MODE (default test) must match the key: test keys never run live and a live key never runs by accident
  const mode = env.PAYMENTS_MODE === 'live' ? 'live' : 'test';
  const enabled = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && String(env.RAZORPAY_KEY_ID).startsWith(`rzp_${mode}_`));
  return {
    provider: enabled ? 'razorpay' : null,
    enabled,
    mode: enabled ? mode : null,
    keyId: enabled ? env.RAZORPAY_KEY_ID : null, // the key id is public by design; the secret never leaves the server
    methods: enabled ? ['upi', 'credit_card', 'debit_card', 'netbanking', 'emi', 'paylater', 'wallet'] : [],
  };
}
