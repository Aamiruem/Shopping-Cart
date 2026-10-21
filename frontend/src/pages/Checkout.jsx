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

const PAYMENT_OPTIONS = [
  { id: 'upi', icon: 'phone', label: 'UPI', note: 'Pay by any UPI app · OTP verified (demo — no real charge)' },
  { id: 'card', icon: 'card', label: 'Credit / Debit / ATM Card', note: 'Visa, Mastercard, RuPay · OTP verified (demo — no real charge)' },
  { id: 'cod', icon: 'truck', label: 'Cash on Delivery', note: 'Pay when your order arrives' },
];
const ONLINE_PAYMENTS = ['upi', 'card'];

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

  // Cash on delivery places the order straight away; online payments need an emailed OTP first
  const placeOrder = async () => {
    if (ONLINE_PAYMENTS.includes(payment)) return setOtpOpen(true);
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
          {PAYMENT_OPTIONS.map((p) => (
            <label key={p.id} className={`payment-option ${payment === p.id ? 'selected' : ''}`}>
              <input type="radio" name="payment" checked={payment === p.id} onChange={() => setPayment(p.id)} />
              <Icon name={p.icon} size={20} />
              <div><strong>{p.label}</strong><span className="muted small">{p.note}</span></div>
            </label>
          ))}
          <button type="button" className="btn btn-buy btn-lg btn-block" disabled={placing || !address} onClick={placeOrder}>
            {placing ? 'Placing order…' : ONLINE_PAYMENTS.includes(payment) ? `Pay ${formatPrice(cart.total)}` : `Confirm order · ${formatPrice(cart.total)}`}
          </button>
        </Step>
      </div>

      <PriceDetails cart={cart} />
      {otpOpen && <PaymentOtp amount={cart.total} onConfirm={confirmWithOtp} onCancel={() => setOtpOpen(false)} />}
    </div>
  );
}
