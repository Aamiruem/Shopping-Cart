import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { PREVIEW } from '../config';
import AddressForm from '../components/account/AddressForm';
import CouponBox from '../components/cart/CouponBox';
import PriceDetails from '../components/cart/PriceDetails';
import PaymentMethods from '../components/checkout/PaymentMethods';
import PaymentOtp from '../components/checkout/PaymentOtp';
import ProductRail from '../components/product/ProductRail';
import { EmptyState, Spinner } from '../components/common/Feedback';
import Icon from '../components/common/Icon';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { useToast } from '../context/ToastContext';
import { deliveryDate, formatPrice } from '../utils/format';
import { playSound } from '../utils/sound';
import { trackBeginCheckout, trackPurchase } from '../utils/analytics';
import useSeo from '../hooks/useSeo';

const COD = { id: 'cod', icon: 'truck', label: 'Cash on Delivery', note: 'Pay when your order arrives' };
// Real payments through Razorpay (an RBI-authorised payment aggregator) once the store has Razorpay keys. Each choice
// opens Razorpay Checkout on that method; card and bank details are entered on Razorpay's page, never on ours.
// `instruments` is the Razorpay Checkout block shown first for that choice; the shopper can still switch method there.
const ONLINE_OPTIONS = [
  { key: 'upi', method: 'upi', icon: 'phone', label: 'UPI', note: 'Google Pay, PhonePe, Paytm, BHIM or any UPI app', instruments: [{ method: 'upi' }] },
  { key: 'credit_card', method: 'card', icon: 'card', label: 'Credit card', note: 'Visa, Mastercard, RuPay, Amex · confirmed with your bank’s OTP', instruments: [{ method: 'card', types: ['credit'] }] },
  { key: 'debit_card', method: 'card', icon: 'card', label: 'Debit / ATM card', note: 'Visa, Mastercard, RuPay · confirmed with your bank’s OTP', instruments: [{ method: 'card', types: ['debit'] }] },
  { key: 'netbanking', method: 'netbanking', icon: 'bank', label: 'Net banking', note: 'All major Indian banks', instruments: [{ method: 'netbanking' }] },
  { key: 'emi', method: 'emi', icon: 'clock', label: 'EMI', note: 'Credit card, debit card and cardless EMI, where your bank offers it', instruments: [{ method: 'emi' }, { method: 'cardless_emi' }] },
  { key: 'paylater', method: 'paylater', icon: 'zap', label: 'Pay Later', note: 'Buy now, pay later, if you’re eligible', instruments: [{ method: 'paylater' }] },
  { key: 'wallet', method: 'wallet', icon: 'wallet', label: 'Wallets', note: 'Popular mobile wallets', instruments: [{ method: 'wallet' }] },
].map((o) => ({ ...o, id: `online-${o.key}` }));
const LIVE_OPTIONS = [...ONLINE_OPTIONS, COD];
// Before online payments are switched on, shoppers still see every method (marked "Coming soon") and pay cash on delivery
const SOON_OPTIONS = [COD, ...ONLINE_OPTIONS.map((o) => ({ ...o, disabled: true }))];
const PROGRESS = [[2, 'Address'], [3, 'Order Summary'], [4, 'Payment']];

// Flipkart-style progress across the top: Address → Order Summary → Payment
function CheckoutProgress({ step, onStep, canGo }) {
  return (
    <ol className="checkout-progress" aria-label="Checkout progress">
      {PROGRESS.map(([n, label], i) => {
        const state = step > n ? 'done' : step === n ? 'current' : '';
        return (
          <li key={n} className={state} aria-current={step === n ? 'step' : undefined}>
            <button type="button" disabled={!canGo(n)} onClick={() => onStep(n)}>
              <span className="progress-dot">{step > n ? <Icon name="check" size={13} strokeWidth={3} /> : i + 1}</span>
              <span>{label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// Products that go with what's in the cart, for the bottom of checkout
function useRelated(cart) {
  const first = cart.items[0]?.productId;
  const [related, setRelated] = useState([]);
  useEffect(() => {
    if (!first) return undefined;
    let cancelled = false;
    api.together(first)
      .then((r) => !cancelled && setRelated(r.items || []))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [first]);
  const inCart = new Set(cart.items.map((i) => i.productId));
  return related.filter((p) => !inCart.has(p._id));
}
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

// onOpen: the step's title opens it (once there's an address), so shoppers can jump to Payment options directly
function Step({ number, title, done, summary, active, onChange, onOpen, children }) {
  const canOpen = Boolean(onOpen) && !active;
  return (
    <section className={`checkout-step panel ${active ? 'active' : ''} ${canOpen ? 'openable' : ''}`}>
      <header>
        <span className="step-num">{done && !active ? <Icon name="check" size={14} /> : number}</span>
        <div className="step-title">
          {canOpen ? (
            <button type="button" className="step-open" onClick={onOpen} aria-expanded="false"><h2>{title}</h2></button>
          ) : (
            <h2>{title}</h2>
          )}
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
  const { cart, loading, refresh, update } = useCart();
  const related = useRelated(cart);
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
  const checkoutTracked = useRef(false);

  useEffect(() => {
    if (checkoutTracked.current || !cart.items.length) return;
    checkoutTracked.current = true;
    trackBeginCheckout(cart);
  }, [cart]);

  useEffect(() => {
    api.paymentsConfig()
      .then((cfg) => {
        setGateway(cfg);
        if (cfg.enabled) setPayment('online-upi');
      })
      .catch(() => setGateway({ enabled: false }));
  }, []);
  // Without the full API there's no OTP demo either, so the store takes cash on delivery only
  const options = gateway?.enabled ? LIVE_OPTIONS : PREVIEW ? SOON_OPTIONS : DEMO_OPTIONS;

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
    trackPurchase(order.id, cart);
    await refresh();
    playSound('success');
    navigate(`/orders/${order.id}`, { replace: true, state: { justPlaced: true } });
  };

  // UPI / net banking / card / wallet in Razorpay Checkout; the order is created only after the server verifies the payment
  const payOnline = async ({ method, label, instruments }) => {
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
        prefill: { ...start.prefill, method }, // opens Razorpay on the method the shopper chose
        // ...with that choice (say, credit cards only) shown first, and every other method still one tap away
        config: { display: { blocks: { chosen: { name: label, instruments } }, sequence: ['block.chosen'], preferences: { show_default_blocks: true } } },
        theme: { color: '#2874f0' },
        handler: async (response) => {
          try {
            const { orderId } = await api.verifyPayment(response);
            trackPurchase(orderId, cart);
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
    const online = ONLINE_OPTIONS.find((o) => o.id === payment);
    if (online) return payOnline(online);
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

  const setQty = async (productId, qty) => {
    try {
      await update(productId, qty);
    } catch (err) {
      toast.show(err.message, 'error');
    }
  };

  return (
    <div className="page-cart container">
      <CheckoutProgress step={step} onStep={setStep} canGo={(n) => n === 2 || Boolean(address)} />
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
                <a className="map-link" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${a.line1}, ${a.city}, ${a.state} ${a.pincode}`)}`} target="_blank" rel="noreferrer"><Icon name="mapPin" size={14} /> Check on Google Maps</a>
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
          onOpen={address ? () => setStep(3) : undefined}
        >
          {address && (
            <div className="deliver-to">
              <p className="muted small">Deliver to:</p>
              <p><strong>{address.name}</strong> <span className="chip">{address.type}</span></p>
              <p className="small">{address.line1}, {address.city}, {address.state} {address.pincode} · {address.phone}</p>
            </div>
          )}
          <ul className="summary-list checkout-items">
            {cart.items.map((i) => (
              <li key={i.productId}>
                <img src={i.image} alt="" />
                <div>
                  <p className="item-name">{i.name}</p>
                  {i.brand && <p className="muted small">{i.brand}</p>}
                  <label className="qty-pick small">Qty:{' '}
                    <select value={i.qty} onChange={(e) => setQty(i.productId, Number(e.target.value))} aria-label={`Quantity of ${i.name}`}>
                      {Array.from({ length: Math.max(1, Math.min(10, i.stock || 10)) }, (_, n) => n + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                  <p className="small delivery-by"><Icon name="truck" size={13} /> Delivery by <strong>{deliveryDate(4)}</strong></p>
                </div>
                <strong>{formatPrice(i.subtotal)}</strong>
              </li>
            ))}
          </ul>
          <div className="step-foot">
            {!PREVIEW && <p className="muted small">Order confirmation will be sent to <strong>{user.email}</strong></p>}
            <button type="button" className="btn btn-buy" onClick={() => setStep(4)}>Continue</button>
          </div>
        </Step>

        <Step number={4} title={<>Payment options <span className="secure-badge"><Icon name="lock" size={12} /> 100% Secure</span></>} active={step === 4} summary={address ? undefined : 'Choose a delivery address first'} onOpen={address ? () => setStep(4) : undefined}>
          <PaymentMethods
            methods={options}
            selected={payment}
            onSelect={setPayment}
            total={cart.total}
            placing={placing}
            canPay={Boolean(address)}
            onPay={placeOrder}
          />
        </Step>

        <ProductRail title="Customers also bought" subtitle="Goes well with what’s in your cart" products={related.slice(0, 12)} />
      </div>

      <PriceDetails cart={cart}><CouponBox /></PriceDetails>
      {otpOpen && <PaymentOtp amount={cart.total} onConfirm={confirmWithOtp} onCancel={() => setOtpOpen(false)} />}
    </div>
  );
}
