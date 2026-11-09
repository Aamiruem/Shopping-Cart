import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { formatPrice } from '../../utils/format';
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
  { icon: 'clock', label: 'EMI', note: 'Credit card and cardless EMI, where offered' },
  { icon: 'zap', label: 'Pay Later', note: 'Buy now, pay later, if you’re eligible' },
  { icon: 'wallet', label: 'Wallets', note: 'Popular mobile wallets' },
];

const FREE_DELIVERY_ABOVE = 499;
const DELIVERY_FEE = 40;

// What's true for every order in store mode, as service buttons plus the ways to pay. Each button opens the details
// for this product, with the policy that backs it and what to do next. No sample offers or promises.
function servicesFor(product, online) {
  const free = product.price >= FREE_DELIVERY_ABOVE;
  return [
    {
      id: 'delivery', icon: 'truck', label: 'Free delivery', note: `On orders of ₹${FREE_DELIVERY_ABOVE}+`, color: '#16a34a',
      title: free ? 'This item ships free' : `Free delivery from ₹${FREE_DELIVERY_ABOVE}`,
      points: [
        free ? `At ${formatPrice(product.price)}, this item qualifies for free delivery.` : `Add items worth ${formatPrice(FREE_DELIVERY_ABOVE - product.price)} more for free delivery; otherwise it’s a flat ${formatPrice(DELIVERY_FEE)}.`,
        'Most orders arrive in 2–4 working days. Check your pincode in the box on the right for an estimate.',
        'Your order page shows the courier and tracking number as soon as it ships.',
      ],
      links: [['/shipping', 'Shipping policy']],
    },
    {
      id: 'cod', icon: 'wallet', label: 'Cash on delivery', note: 'Pay when it arrives', color: '#ea580c',
      title: 'Pay when your order arrives',
      points: [
        `Choose “Cash on Delivery” at checkout and pay ${formatPrice(product.price)} (plus any delivery fee) in cash or by UPI to the delivery agent.`,
        'Nothing is charged if you cancel before it ships.',
        online ? 'Prefer paying now? UPI, credit and debit cards, net banking, EMI, Pay Later and wallets are available at checkout.' : 'Online payment options are coming soon.',
      ],
      links: [['/help#payments', 'Payment help']],
    },
    {
      id: 'cancel', icon: 'x', label: 'Free cancellation', note: 'Before it ships', color: '#e11d48',
      title: 'Cancel free, any time before it ships',
      points: [
        'Open the order in My Orders and choose “Cancel order”. No fee, no questions.',
        'Paid online? The full amount goes back to the same UPI, bank account or card, usually within 5–7 working days.',
        'Once it has shipped, you can return it after delivery instead.',
      ],
      links: [['/orders', 'My Orders'], ['/refunds', 'Cancellation & refund policy']],
    },
    {
      id: 'returns', icon: 'returns', label: '7-day returns', note: 'Full refund', color: '#7c3aed',
      title: 'Return within 7 days of delivery',
      points: [
        'Damaged, wrong, the wrong size or just not right? Open the order, choose “Return order” and pick a reason.',
        'Once approved, our courier picks it up in 2–3 days. Keep it unused, with its tags and box.',
        'Your refund goes to your original payment method, or to the UPI ID or bank account you give for cash orders.',
      ],
      links: [['/orders', 'Start a return'], ['/refunds', 'Return policy']],
    },
    ...(online ? [{
      id: 'secure', icon: 'lock', label: 'Secure payment', note: 'By Razorpay', color: '#2563eb',
      title: 'Payments you can trust',
      points: [
        'Online payments are processed by Razorpay, an RBI-authorised payment aggregator.',
        'Card and bank details are entered on Razorpay’s page; we never see or store them.',
        'An order is placed only after your payment is confirmed, and failed payments are never charged.',
      ],
      links: [['/terms', 'Terms of use']],
    }] : []),
  ];
}

export default function StoreFacts({ product }) {
  const online = useOnlinePayments();
  const [open, setOpen] = useState(null);
  const services = servicesFor(product, online);
  const shown = services.find((s) => s.id === open);
  return (
    <>
      <ul className="service-icons" aria-label="Services">
        {services.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className={open === s.id ? 'active' : ''}
              style={{ '--tone': s.color }}
              aria-expanded={open === s.id}
              aria-controls="service-detail"
              onClick={() => setOpen(open === s.id ? null : s.id)}
            >
              <span className="service-icon"><Icon name={s.icon} size={22} /></span>
              <strong>{s.label}</strong>
              <small>{s.note}</small>
            </button>
          </li>
        ))}
      </ul>
      {shown && (
        <div id="service-detail" className="service-detail" style={{ '--tone': shown.color }} role="region" aria-label={shown.label}>
          <div className="service-detail-head">
            <span className="service-icon"><Icon name={shown.icon} size={18} /></span>
            <strong>{shown.title}</strong>
            <button type="button" className="service-close" onClick={() => setOpen(null)} aria-label="Close"><Icon name="x" size={16} /></button>
          </div>
          <ul>{shown.points.map((p) => <li key={p}><Icon name="check" size={14} /> {p}</li>)}</ul>
          <div className="service-links">
            {shown.links.map(([to, label], i) => <Link key={to + label} to={to} className={i === 0 ? 'btn btn-outline btn-sm' : 'btn-link small'}>{label}</Link>)}
          </div>
        </div>
      )}

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
