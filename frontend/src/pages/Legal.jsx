import { Link } from 'react-router-dom';
import { EmptyState } from '../components/common/Feedback';
import { CONTACT_EMAIL, PREVIEW } from '../config';
import useSeo from '../hooks/useSeo';
import { ABOUT_DESCRIPTION, PRIVACY_DESCRIPTION } from '../seo/copy';

const contactLine = CONTACT_EMAIL ? <>Write to us at <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</> : 'Contact details will be published here before the store opens.';

export function About() {
  useSeo({ title: 'About Us', description: ABOUT_DESCRIPTION, path: '/about' });
  return (
    <article className="legal-page container panel">
      <h1>About Arvixa Store</h1>
      <p>Arvixa Store is an online marketplace being built for shoppers and sellers in India, bringing mobiles, electronics, fashion, beauty, home, kitchen and grocery products together in one place.</p>
      {PREVIEW && <p>You can browse the catalog today. Ordering opens shortly, and prices may change.</p>}
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

// Replaces the login and sign-up pages while the store has no accounts
export function OpeningSoon() {
  useSeo({ title: 'Opening soon', noindex: true });
  return (
    <div className="container">
      <EmptyState
        icon="shield"
        title="Accounts are opening soon"
        message="Arvixa Store is in preview, so sign-in, cart and checkout aren’t available yet. You can still browse the whole catalog."
        action={{ to: '/products', label: 'Browse products' }}
      />
    </div>
  );
}
