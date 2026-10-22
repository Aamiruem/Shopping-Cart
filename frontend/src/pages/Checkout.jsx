import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import AddressForm from '../components/account/AddressForm';
import PriceDetails from '../components/cart/PriceDetails';
import PaymentOtp from '../components/checkout/PaymentOtp';
import { EmptyState, Spinner } from '../components/common/Feedback';
import Icon from '../components/common/Icon';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { useToast } from '../context/ToastContext';
import { formatPrice } from '../utils/format';
import { playSound } from '../utils/sound';
import useSeo from '../hooks/useSeo';

const COD = { id: 'cod', icon: 'truck', label: 'Cash on Delivery', note: 'Pay when your order arrives' };
// Real payments through Razorpay (RBI-authorised payment aggregator) when the store has Razorpay keys
const LIVE_OPTIONS = [
  {
    id: 'razorpay',
    icon: 'card',
    label: 'Pay online: UPI, Net Banking, Cards, Wallets',
    note: 'Google Pay, PhonePe, Paytm, BHIM UPI · Net banking with all major banks · Visa, Mastercard, RuPay · Secured by Razorpay',
  },
  COD,
];
// Development without Razorpay keys: an emailed OTP stands in for the payment gateway
const DEMO_OPTIONS = [
  { id: 'upi', icon: 'phone', label: 'UPI', note: 'Pay by any UPI app · OTP verified (demo — no real charge)' },
  { id: 'card', icon: 'card', label: 'Credit / Debit / ATM Card', note: 'Visa, Mastercard, RuPay · OTP verified (demo — no real charge)' },
  COD,
];
const OTP_DEMO = ['upi', 'card'];
const RAZORPAY_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

// Razorpay Checkout is loaded only when a shopper actually pays online
function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = RAZORPAY_SCRIPT;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load the payment window. Check your connection and try again.'));
    document.body.appendChild(script);
  });
}

function Step({ number, title, done, summary, active, onChange, children }) {
  return (
    <section className={`checkout-step panel ${active ? 'active' : ''}`}>
      <header>
        <span className="step-num">{done && !active ? <Icon name="check" size={14} /> : number}</span>
        <div className="step-title">
          <h2>{title}</h2>
          {!active && summary && <p>{summary}</p>}
        </div>
        {done && !active && onChange && <button type="button" className="btn btn-outline btn-sm" onClick={onChange}>Change</button>}
      </header>
      {active && <div className="step-body">{children}</div>}
    </section>
  );
}

export default function Checkout() {
  useSeo({ title: 'Checkout', noindex: true });
  const { user } = useAuth();
  const { cart, loading, refresh } = useCart();
  const toast = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState(2);
  const [addresses, setAddresses] = useState(null);
  const [addressId, setAddressId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [payment, setPayment] = useState('cod');
  const [placing, setPlacing] = useState(false);
  const [otpOpen, setOtpOpen] = useState(false);
  const [gateway, setGateway] = useState(null); // { enabled, keyId } from the API

  useEffect(() => {
    api.paymentsConfig()
      .then((cfg) => {
        setGateway(cfg);
        if (cfg.enabled) setPayment('razorpay');
      })
      .catch(() => setGateway({ enabled: false }));
  }, []);
  const options = gateway?.enabled ? LIVE_OPTIONS : DEMO_OPTIONS;

  useEffect(() => {
    api.addresses()
      .then((list) => {
        setAddresses(list);
        setAddressId(list[0]?.id ?? null);
        setAdding(!list.length);
      })
      .catch(() => setAddresses([]));
  }, []);

  if (loading || addresses === null) return <Spinner />;
  if (!cart.items.length) {
    return <div className="container"><EmptyState icon="cart" title="Nothing to check out" message="Your cart is empty." action={{ to: '/products', label: 'Shop now' }} /></div>;
  }

  const address = addresses.find((a) => a.id === addressId);

  const onAddressSaved = (saved) => {
    setAddresses([saved, ...addresses]);
    setAddressId(saved.id);
    setAdding(false);
  };

  const submitOrder = async (otp) => {
    const order = await api.checkout({ addressId, paymentMethod: payment, ...(otp ? { otp } : {}) });
    await refresh();
    playSound('success');
    navigate(`/orders/${order.id}`, { replace: true, state: { justPlaced: true } });
  };

  // UPI / net banking / card / wallet in Razorpay Checkout; the order is created only after the server verifies the payment
  const payOnline = async () => {
    setPlacing(true);
    try {
      await loadRazorpay();
      const start = await api.startPayment({ addressId });
      const checkout = new window.Razorpay({
        key: start.keyId,
        order_id: start.orderId,
        amount: start.amount,
        currency: start.currency,
        name: start.name,
        description: start.description,
        image: `${window.location.origin}/brand/arvixa-mark-192.png`,
        prefill: start.prefill,
        theme: { color: '#2874f0' },
        handler: async (response) => {
          try {
            const { orderId } = await api.verifyPayment(response);
            await refresh();
            playSound('success');
            navigate(`/orders/${orderId}`, { replace: true, state: { justPlaced: true } });
          } catch (err) {
            playSound('error');
            toast.show(err.message, 'error');
            setPlacing(false);
          }
        },
        modal: { ondismiss: () => setPlacing(false), confirm_close: true },
      });
      checkout.on('payment.failed', (r) => toast.show(r.error?.description || 'Payment failed. No money was taken; please try again.', 'error'));
      checkout.open();
    } catch (err) {
      playSound('error');
      toast.show(err.message, 'error');
      setPlacing(false);
    }
  };

  // Cash on delivery places the order straight away; the dev OTP demo asks for an emailed code first
  const placeOrder = async () => {
    if (payment === 'razorpay') return payOnline();
    if (OTP_DEMO.includes(payment)) return setOtpOpen(true);
    setPlacing(true);
    try {
      await submitOrder();
    } catch (err) {
      playSound('error');
      toast.show(err.message, 'error');
      setPlacing(false);
    }
  };

  const confirmWithOtp = async (otp) => {
    try {
      await submitOrder(otp);
    } catch (err) {
      playSound('error');
      throw err; // PaymentOtp shows the message next to the code input
    }
  };

  return (
    <div className="page-cart container">
      <div className="checkout-steps">
        <Step number={1} title="Login" done summary={`${user.name} · ${user.email}`} />

        <Step
          number={2}
          title="Delivery address"
          active={step === 2}
          done={!!address}
          summary={address && `${address.name}, ${address.line1}, ${address.city} - ${address.pincode}`}
          onChange={() => setStep(2)}
        >
          {addresses.map((a) => (
            <label key={a.id} className={`address-option ${a.id === addressId ? 'selected' : ''}`}>
              <input type="radio" name="address" checked={a.id === addressId} onChange={() => setAddressId(a.id)} />
              <div>
                <p><strong>{a.name}</strong> <span className="chip">{a.type}</span> <strong>{a.phone}</strong></p>
                <p className="muted">{a.line1}, {a.city}, {a.state} — <strong>{a.pincode}</strong></p>
                {a.id === addressId && <button type="button" className="btn btn-buy" onClick={() => setStep(3)}>Deliver here</button>}
              </div>
            </label>
          ))}
          {adding ? (
            <AddressForm defaults={{ name: user.name, phone: user.phone || '' }} onSaved={onAddressSaved} onCancel={addresses.length ? () => setAdding(false) : null} />
          ) : (
            <button type="button" className="add-new" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Add a new address</button>
          )}
        </Step>

        <Step
          number={3}
          title="Order summary"
          active={step === 3}
          done={step > 3}
          summary={`${cart.items.length} item${cart.items.length === 1 ? '' : 's'}`}
          onChange={() => setStep(3)}
        >
          <ul className="summary-list">
            {cart.items.map((i) => (
              <li key={i.productId}>
                <img src={i.image} alt="" />
                <div>
                  <p>{i.name}</p>
                  <p className="muted small">Qty: {i.qty}</p>
                </div>
                <strong>{formatPrice(i.subtotal)}</strong>
              </li>
            ))}
          </ul>
          <div className="step-foot">
            <p className="muted small">Order confirmation will be sent to <strong>{user.email}</strong></p>
            <button type="button" className="btn btn-buy" onClick={() => setStep(4)}>Continue</button>
          </div>
        </Step>

        <Step number={4} title="Payment options" active={step === 4}>
          {options.map((p) => (
            <label key={p.id} className={`payment-option ${payment === p.id ? 'selected' : ''}`}>
              <input type="radio" name="payment" checked={payment === p.id} onChange={() => setPayment(p.id)} />
              <Icon name={p.icon} size={20} />
              <div><strong>{p.label}</strong><span className="muted small">{p.note}</span></div>
            </label>
          ))}
          <button type="button" className="btn btn-buy btn-lg btn-block" disabled={placing || !address} onClick={placeOrder}>
            {placing ? 'Processing…' : payment === 'cod' ? `Confirm order · ${formatPrice(cart.total)}` : `Pay ${formatPrice(cart.total)}`}
          </button>
        </Step>
      </div>

      <PriceDetails cart={cart} />
      {otpOpen && <PaymentOtp amount={cart.total} onConfirm={confirmWithOtp} onCancel={() => setOtpOpen(false)} />}
    </div>
  );
}
