import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import Icon from '../common/Icon';

// One request per visit, shared by every product page
let paymentsRequest;
const loadPayments = () => {
  paymentsRequest ??= api.paymentsConfig().catch(() => ({ enabled: false }));
  return paymentsRequest;
};

const ONLINE = [
  { icon: 'phone', label: 'UPI', note: 'Google Pay, PhonePe, Paytm, BHIM and any UPI app' },
  { icon: 'card', label: 'Credit & debit cards', note: 'Visa, Mastercard, RuPay' },
  { icon: 'home', label: 'Net banking', note: 'All major Indian banks' },
  { icon: 'zap', label: 'Wallets & EMI', note: 'Where your bank or card offers it' },
];

// What's true for every order in store mode: how to pay, delivery charges and cancelling. No sample offers or promises.
export default function StoreFacts({ product }) {
  const [online, setOnline] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadPayments().then((cfg) => !cancelled && setOnline(Boolean(cfg.enabled)));
    return () => {
      cancelled = true;
    };
  }, []);
  const outOfStock = !product.stock;

  return (
    <>
      <p className={`stock ${outOfStock ? 'text-error' : 'text-success'}`}>{outOfStock ? 'Currently out of stock' : 'In stock'}</p>

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

      <div className="detail-section detail-grid">
        <h3>Delivery</h3>
        <ul className="service-list">
          <li><Icon name="truck" size={16} /> Free delivery on orders of ₹499 or more, otherwise ₹40</li>
          <li><Icon name="x" size={16} /> Cancel any time before your order ships{online ? '; online payments are refunded in full' : ''}</li>
        </ul>
      </div>
    </>
  );
}
