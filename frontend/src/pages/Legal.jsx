import { Link } from 'react-router-dom';
import { EmptyState } from '../components/common/Feedback';
import { CONTACT_EMAIL, LEGAL, SHOPPING } from '../config';
import useSeo from '../hooks/useSeo';
import { ABOUT_DESCRIPTION, PRIVACY_DESCRIPTION } from '../seo/copy';

const contactLine = CONTACT_EMAIL ? <>Write to us at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</> : 'Contact details will be published here before the store opens.';

export function About() {
  useSeo({ title: 'About Us', description: ABOUT_DESCRIPTION, path: '/about' });
  return (
    <article className="legal-page container panel">
      <h1>About Arvixa Store</h1>
      <p>Arvixa Store is an online marketplace being built for shoppers and sellers in India, bringing mobiles, electronics, fashion, beauty, home, kitchen and grocery products together in one place.</p>
      {!SHOPPING && <p>You can browse the catalog today. Ordering opens shortly, and prices may change.</p>}
      <p>We plan to serve India first and to expand to other countries in future. Sellers can read about the programme on our <Link to="/sell">Sell on Arvixa Store</Link> page.</p>
      <h2>Contact</h2>
      <p>{contactLine}</p>
    </article>
  );
}

export function Privacy() {
  useSeo({ title: 'Privacy Policy', description: PRIVACY_DESCRIPTION, path: '/privacy' });
  return (
    <article className="legal-page container panel">
      <h1>Privacy Policy</h1>
      <h2>What we collect</h2>
      <p>While you browse, we may record the pages you visit, your approximate location, and your device and browser type. If you create an account, we keep the details you give us, such as your name, email address, mobile number, delivery addresses and orders.</p>
      <h2>Analytics and cookies</h2>
      <p>We use Google Analytics to understand how the store is used. Its cookies are set only if you accept them in the consent banner. Google processes this data under its own <a href="https://policies.google.com/privacy" rel="noopener noreferrer" target="_blank">privacy policy</a>.</p>
      <h2>How we use your information</h2>
      <p>We use it to run and improve the store, deliver orders, give support and keep accounts secure. We don’t sell your personal data.</p>
      <h2>Your choices</h2>
      <p>You can decline analytics cookies, clear them in your browser at any time, and ask us to correct or delete your personal data.</p>
      <h2>Contact</h2>
      <p>{contactLine}</p>
    </article>
  );
}

const UPDATED = '8 November 2026';

// Who runs the store and how to reach them. Only what's been configured is shown (see LEGAL in config.js).
function BusinessDetails() {
  const rows = [
    ['Business name', LEGAL.name],
    ['Registered address', LEGAL.address],
    ['Email', CONTACT_EMAIL && <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>],
    ['Phone', LEGAL.phone],
    ['Grievance officer', LEGAL.grievanceOfficer],
  ].filter(([, value]) => value);
  if (!rows.length) return <p>{contactLine}</p>;
  return (
    <dl className="legal-details">
      {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

export function Terms() {
  useSeo({ title: 'Terms of Use', description: 'The terms for using Arvixa Store and buying from it.', path: '/terms' });
  return (
    <article className="legal-page container panel">
      <h1>Terms of Use</h1>
      <p className="muted small">Last updated: {UPDATED}</p>
      <p>These terms apply when you use Arvixa Store (the website and its services) or buy from it. By creating an account or placing an order you agree to them. If you don’t agree, please don’t use the store.</p>

      <h2>1. Who we are</h2>
      <BusinessDetails />

      <h2>2. Your account</h2>
      <p>You must be at least 18 years old, or use the store with a parent or guardian’s permission. Give accurate details, keep your password private and tell us if you think someone else has used your account. You’re responsible for activity on your account. We may suspend accounts used for fraud, abuse or breaking these terms.</p>

      <h2>3. Products and prices</h2>
      <p>We try to describe and photograph every product accurately, but colours and details can look slightly different on your screen. Prices are in Indian rupees (₹), and the price you pay is the one shown at checkout. If a product is listed at a clearly wrong price, or turns out to be unavailable, we may cancel the order and refund anything you paid in full.</p>

      <h2>4. Orders</h2>
      <p>Placing an order is an offer to buy. It’s accepted when we confirm it on your order page. You can see every order and its status in <Link to="/orders">My Orders</Link>.</p>

      <h2>5. Payment</h2>
      <p>You can pay cash on delivery. Where available, you can also pay online by UPI, credit or debit card, net banking, wallets or EMI. Online payments are processed by Razorpay, an RBI-authorised payment aggregator: we never see or store your full card or bank details. An order is placed only after your payment is confirmed, and if a payment goes through but the order can’t be placed, the money is refunded automatically.</p>

      <h2>6. Delivery</h2>
      <p>See our <Link to="/shipping">Shipping Policy</Link>. In short: we deliver within India, and delivery is free on orders of ₹499 or more and ₹40 below that.</p>

      <h2>7. Cancellations, returns and refunds</h2>
      <p>See our <Link to="/refunds">Cancellation &amp; Refund Policy</Link>. In short: you can cancel any time before your order ships, and online payments for cancelled orders are refunded in full.</p>

      <h2>8. Using the store fairly</h2>
      <p>Don’t misuse the store: no fraud, fake orders, automated access that harms the service, attempts to break its security, or reselling against the law. Reviews and messages you send must be honest and lawful.</p>

      <h2>9. Our content</h2>
      <p>The Arvixa name, logo, design and text belong to us. Product names, brands and photos belong to their owners. You may use the store for your own shopping, not copy or republish it.</p>

      <h2>10. Responsibility</h2>
      <p>We’re responsible for what Indian law makes us responsible for, including under the Consumer Protection Act, 2019. Beyond that, we aren’t liable for indirect losses, or for delays caused by things outside our reasonable control such as courier or network outages.</p>

      <h2>11. Complaints</h2>
      <p>If something goes wrong, contact us using the details above. We’ll acknowledge your complaint within 48 hours and aim to resolve it within one month, as India’s E-Commerce Rules require.</p>

      <h2>12. Changes and law</h2>
      <p>We may update these terms. The date at the top shows the latest version, and each order follows the terms in force when it was placed. These terms are governed by the laws of India, and disputes go to the courts of India.</p>
      <p>See also our <Link to="/privacy">Privacy Policy</Link>.</p>
    </article>
  );
}

export function Refunds() {
  useSeo({ title: 'Cancellation & Refund Policy', description: 'How to cancel an Arvixa Store order and how refunds work.', path: '/refunds' });
  return (
    <article className="legal-page container panel">
      <h1>Cancellation &amp; Refund Policy</h1>
      <p className="muted small">Last updated: {UPDATED}</p>
      <h2>Cancelling an order</h2>
      <p>You can cancel any order that hasn’t shipped yet, from its page in <Link to="/orders">My Orders</Link>. Once an order has shipped it can’t be cancelled.</p>
      <h2>Refunds</h2>
      <ul>
        <li><strong>Paid online</strong> (UPI, card, net banking, wallet or EMI): the full amount goes back to the account you paid from. Banks usually take 5–7 working days to show it.</li>
        <li><strong>Cash on delivery</strong>: nothing is charged for a cancelled order.</li>
        <li>If a payment goes through but the order can’t be placed, the money is refunded automatically.</li>
      </ul>
      <h2>Damaged, wrong or missing items</h2>
      <p>If an item arrives damaged or defective, or isn’t what you ordered, contact us within 7 days of delivery with your order number and a photo. We’ll arrange a replacement or a full refund.</p>
      <h2>Contact</h2>
      <BusinessDetails />
    </article>
  );
}

export function Shipping() {
  useSeo({ title: 'Shipping Policy', description: 'Where Arvixa Store delivers and what delivery costs.', path: '/shipping' });
  return (
    <article className="legal-page container panel">
      <h1>Shipping Policy</h1>
      <p className="muted small">Last updated: {UPDATED}</p>
      <h2>Where we deliver</h2>
      <p>We deliver to addresses in India.</p>
      <h2>Delivery charges</h2>
      <p>Delivery is free on orders of ₹499 or more. Orders below ₹499 have a ₹40 delivery charge, shown before you pay.</p>
      <h2>Tracking</h2>
      <p>Your order page in <Link to="/orders">My Orders</Link> shows its status as it’s packed, shipped and delivered.</p>
      <h2>Problems with delivery</h2>
      <p>If your order is late or something’s wrong, contact us with your order number.</p>
      <BusinessDetails />
    </article>
  );
}

// Replaces the pages the store can't serve yet
export function OpeningSoon() {
  useSeo({ title: 'Opening soon', noindex: true });
  return (
    <div className="container">
      <EmptyState
        icon="shield"
        title={SHOPPING ? 'Seller accounts are opening soon' : 'Accounts are opening soon'}
        message={SHOPPING ? 'Selling on Arvixa Store isn’t available yet. You can still shop the whole catalog.' : 'Arvixa Store is in preview, so sign-in, cart and checkout aren’t available yet. You can still browse the whole catalog.'}
        action={{ to: '/products', label: 'Browse products' }}
      />
    </div>
  );
}
