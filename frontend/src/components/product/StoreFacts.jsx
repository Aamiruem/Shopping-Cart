import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import Icon from '../common/Icon';

// One request per visit, shared by every product page
let paymentsRequest;
const loadPayments = () => {
  paymentsRequest ??= api.paymentsConfig().catch(() => ({ enabled: false }));
  return paymentsRequest;
};

/** True once Razorpay is set up (UPI, cards, net banking, wallets, EMI). */
export function useOnlinePayments() {
  const [online, setOnline] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadPayments().then((cfg) => !cancelled && setOnline(Boolean(cfg.enabled)));
    return () => {
      cancelled = true;
    };
  }, []);
  return online;
}

const ONLINE = [
  { icon: 'phone', label: 'UPI', note: 'Google Pay, PhonePe, Paytm, BHIM and any UPI app' },
  { icon: 'card', label: 'Credit & debit cards', note: 'Visa, Mastercard, RuPay' },
  { icon: 'bank', label: 'Net banking', note: 'All major Indian banks' },
  { icon: 'wallet', label: 'Wallets & EMI', note: 'Where your bank or card offers it' },
];

// What's true for every order in store mode, as Amazon / Flipkart-style service icons plus the ways to pay.
// Each one links to the policy that backs it. No sample offers or promises.
export default function StoreFacts() {
  const online = useOnlinePayments();
  const services = [
    { icon: 'truck', label: 'Free delivery', note: 'On orders of ₹499+', to: '/shipping' },
    { icon: 'wallet', label: 'Cash on delivery', note: 'Pay when it arrives', to: '/terms' },
    { icon: 'x', label: 'Free cancellation', note: 'Before it ships', to: '/refunds' },
    { icon: 'returns', label: '7-day replacement', note: 'If damaged or wrong', to: '/refunds' },
    ...(online ? [{ icon: 'lock', label: 'Secure payment', note: 'By Razorpay', to: '/terms' }] : []),
  ];

  return (
    <>
      <ul className="service-icons" aria-label="Services">
        {services.map((s) => (
          <li key={s.label}>
            <Link to={s.to}>
              <span className="service-icon"><Icon name={s.icon} size={22} /></span>
              <strong>{s.label}</strong>
              <small>{s.note}</small>
            </Link>
          </li>
        ))}
      </ul>

      <div className="detail-section">
        <h3>Ways to pay</h3>
        <ul className="pay-ways">
          {online && ONLINE.map((m) => (
            <li key={m.label}><Icon name={m.icon} size={18} /><span><strong>{m.label}</strong><small>{m.note}</small></span></li>
          ))}
          <li><Icon name="truck" size={18} /><span><strong>Cash on delivery</strong><small>Pay when your order arrives</small></span></li>
        </ul>
        {online && <p className="muted small"><Icon name="lock" size={12} /> Online payments are processed securely by Razorpay.</p>}
      </div>
    </>
  );
}
