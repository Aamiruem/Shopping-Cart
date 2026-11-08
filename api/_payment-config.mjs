// What the checkout page can offer. No dependencies, so the catalog function can answer without loading the
// payment code. Online payment switches on once both Razorpay keys are set in the deployment's environment.
export function paymentsConfig(env = process.env) {
  const enabled = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
  return {
    provider: enabled ? 'razorpay' : null,
    enabled,
    keyId: enabled ? env.RAZORPAY_KEY_ID : null, // the key id is public by design; the secret never leaves the server
    methods: enabled ? ['upi', 'card', 'netbanking', 'emi', 'paylater', 'wallet'] : [],
  };
}
