import Icon from '../common/Icon';
import { formatPrice } from '../../utils/format';

// What each method's panel says and asks for. Card, UPI and bank details are typed on Razorpay's page, never on ours.
const DETAILS = {
  upi: {
    title: 'Pay with UPI',
    points: ['Scan a QR code or pay from Google Pay, PhonePe, Paytm, BHIM or any UPI app.', 'Approve the payment in your app; your order is placed straight away.'],
    apps: ['Google Pay', 'PhonePe', 'Paytm', 'BHIM'],
  },
  credit_card: {
    title: 'Pay by credit card',
    points: ['Visa, Mastercard, RuPay and Amex.', 'Confirmed with your bank’s OTP. Card details go to Razorpay only.'],
  },
  debit_card: {
    title: 'Pay by debit or ATM card',
    points: ['Visa, Mastercard and RuPay debit cards.', 'Confirmed with your bank’s OTP. Card details go to Razorpay only.'],
  },
  netbanking: {
    title: 'Net banking',
    points: ['SBI, HDFC, ICICI, Axis, Kotak and every other major bank.', 'You’ll sign in to your bank’s own page to approve the payment.'],
  },
  emi: {
    title: 'Pay in EMIs',
    points: ['Credit card, debit card and cardless EMI, where your bank or provider offers it.', 'You’ll see the plans you’re eligible for, with interest, before you confirm.'],
  },
  paylater: {
    title: 'Pay Later',
    points: ['Buy now and pay later, if your Pay Later provider approves you.', 'Repay on the provider’s schedule.'],
  },
  wallet: {
    title: 'Wallets',
    points: ['Pay from a popular mobile wallet balance.'],
  },
  cod: {
    title: 'Cash on Delivery',
    points: ['Pay in cash, or by UPI to the delivery agent, when your order arrives.', 'No extra fee. Cancel free any time before it ships.'],
  },
};

/**
 * Flipkart-style payment step: the methods on the left, the chosen one's details and its button on the right.
 * `methods`: [{ id, key, icon, label, note, disabled }]. Without online payments set up, online methods show as
 * "Coming soon" and cash on delivery is the way to pay.
 */
export default function PaymentMethods({ methods, selected, onSelect, total, placing, canPay, onPay }) {
  const chosen = methods.find((m) => m.id === selected) || methods.find((m) => !m.disabled);
  const detail = DETAILS[chosen?.key || chosen?.id] || { title: chosen?.label, points: [chosen?.note].filter(Boolean) };
  const cod = chosen?.id === 'cod';

  return (
    <div className="pay-layout">
      <ul className="pay-method-list" role="radiogroup" aria-label="Payment method">
        {methods.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              role="radio"
              aria-checked={chosen?.id === m.id}
              className={`pay-method ${chosen?.id === m.id ? 'selected' : ''}`}
              onClick={() => onSelect(m.id)}
            >
              <span className={`pay-icon pay-${m.key || m.id}`}><Icon name={m.icon} size={20} /></span>
              <span className="pay-method-text">
                <strong>{m.label}</strong>
                <small>{m.disabled ? 'Coming soon' : m.note}</small>
              </span>
              <Icon name="chevronRight" size={16} className="pay-chevron" />
            </button>
          </li>
        ))}
      </ul>

      <section className="pay-panel" aria-live="polite">
        <h3>{detail.title}</h3>
        <ul className="pay-points">
          {detail.points.map((p) => <li key={p}><Icon name="check" size={14} /> {p}</li>)}
        </ul>
        {detail.apps && !chosen.disabled && (
          <p className="pay-apps">{detail.apps.map((a) => <span key={a} className="chip">{a}</span>)}<span className="muted small">or any UPI app</span></p>
        )}
        {chosen?.disabled ? (
          <div className="pay-soon-box">
            <Icon name="clock" size={18} />
            <p><strong>{chosen.label} is coming soon.</strong> Online payments switch on once the store’s payment gateway is live. For now, choose <button type="button" className="btn-link" onClick={() => onSelect('cod')}>Cash on Delivery</button>.</p>
          </div>
        ) : (
          <>
            <p className="pay-amount"><span className="muted">Amount to pay{cod ? ' on delivery' : ''}</span><strong>{formatPrice(total)}</strong></p>
            <button type="button" className="btn btn-buy btn-lg btn-block" disabled={placing || !canPay} onClick={onPay}>
              {placing ? 'Processing…' : cod ? 'Place order' : `Pay ${formatPrice(total)}`}
            </button>
            {!cod && <p className="secure-note"><Icon name="lock" size={14} /> Processed by Razorpay, an RBI-authorised payment aggregator. A QR code and your app options open in the next window.</p>}
          </>
        )}
      </section>
    </div>
  );
}
