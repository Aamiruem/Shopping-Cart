import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import Icon from '../components/common/Icon';
import { useAuth } from '../context/AuthContext';

const STEPS = [
  { icon: 'user', title: 'Create an account', text: 'Sign up with your email or Google in under a minute.' },
  { icon: 'briefcase', title: 'Set up your store', text: 'Pick a store name. GSTIN and business phone are optional to start.' },
  { icon: 'upload', title: 'List your products', text: 'Add photos, price, MRP and stock. Upload a turntable set for a 360° view.' },
  { icon: 'package', title: 'Sell and grow', text: 'Track orders, export CSVs and let the analytics tell you what to restock.' },
];

const FEATURES = [
  { icon: 'tag', title: 'Product manager', text: 'Create, edit, list and unlist products. Change price and stock inline from one table.' },
  { icon: 'rotate', title: '360° product views', text: 'Upload 4 or more photos taken while turning the item, and shoppers can spin it on the product page.' },
  { icon: 'barChart', title: 'Sales dashboard', text: 'Revenue trend, category mix, conversion funnel, busiest hours and top products at a glance.' },
  { icon: 'zap', title: 'AI forecasts', text: 'Revenue forecast for the next 30 days and a prediction of next month’s best sellers.' },
  { icon: 'users', title: 'Customer insights', text: 'Customer segments, churn risk and a win-back list, so you know who to bring back.' },
  { icon: 'card', title: 'Every way to pay', text: 'Shoppers pay by UPI, card or cash on delivery. Online payments are verified by OTP.' },
];

const FAQ = [
  { q: 'Do I need a GSTIN to start?', a: 'No. You can create your store with just a store name and add your GSTIN later from the Seller Hub.' },
  { q: 'What can I sell?', a: 'Mobiles, electronics, fashion, watches and bags, beauty, home and furniture, kitchen, sports and grocery.' },
  { q: 'How do I add a 360° view?', a: 'Place the product on a turntable or rotate it by hand and take 4 to 36 photos at even angles. Upload them in order under “360° view” when you add the product.' },
  { q: 'Where do I see my orders?', a: 'Seller Hub → Orders lists every order that contains your products, and you can export them to CSV.' },
];

// Public "Sell on Arvixa" page: explains the seller programme and leads into onboarding
export default function Sell() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);

  useEffect(() => {
    api.categories()
      .then((rows) => setStats({ categories: rows.length, products: rows.reduce((sum, r) => sum + r.count, 0) }))
      .catch(() => setStats(null));
  }, []);

  const isSeller = ['seller', 'admin'].includes(user?.role);
  const cta = isSeller
    ? { to: '/seller/dashboard', label: 'Go to Seller Hub' }
    : { to: '/seller/register', label: user ? 'Create your store' : 'Start selling' };

  return (
    <div className="page-sell">
      <section className="sell-hero">
        <div className="container sell-hero-inner">
          <div>
            <p className="sell-eyebrow">Arvixa for sellers</p>
            <h1>Sell to shoppers across India</h1>
            <p className="sell-lead">Open your store in minutes, list products with photos and 360° views, and grow with analytics built into your Seller Hub.</p>
            <div className="sell-actions">
              <Link to={cta.to} className="btn btn-buy btn-lg">{cta.label} <Icon name="arrowRight" size={18} /></Link>
              <a href="#how-it-works" className="btn sell-btn-ghost btn-lg">How it works</a>
            </div>
            {!user && <p className="sell-note">Already a seller? <Link to="/login" state={{ from: { pathname: '/seller/dashboard' } }}>Log in to your Seller Hub</Link></p>}
          </div>
          <ul className="sell-stats" aria-label="Marketplace at a glance">
            <li><strong>{stats ? stats.products.toLocaleString('en-IN') : '—'}</strong><span>products live</span></li>
            <li><strong>{stats ? stats.categories : '—'}</strong><span>categories to sell in</span></li>
            <li><strong>3</strong><span>ways for shoppers to pay</span></li>
            <li><strong>30-day</strong><span>AI sales forecast</span></li>
          </ul>
        </div>
      </section>

      <div className="container sell-body">
        <section id="how-it-works" className="panel sell-section">
          <h2>How it works</h2>
          <ol className="sell-steps">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <span className="sell-step-num">{i + 1}</span>
                <Icon name={s.icon} size={22} />
                <strong>{s.title}</strong>
                <p>{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="panel sell-section">
          <h2>Everything you need in one Seller Hub</h2>
          <div className="sell-features">
            {FEATURES.map((f) => (
              <div key={f.title} className="sell-feature">
                <span className="sell-feature-icon"><Icon name={f.icon} size={20} /></span>
                <div><strong>{f.title}</strong><p>{f.text}</p></div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel sell-section">
          <h2>Questions sellers ask</h2>
          <div className="sell-faq">
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>{f.q}<Icon name="chevronDown" size={16} /></summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="sell-cta panel">
          <div>
            <h2>Ready to open your store?</h2>
            <p>It takes a store name and a minute of your time.</p>
          </div>
          <Link to={cta.to} className="btn btn-buy btn-lg">{cta.label}</Link>
        </section>
      </div>
    </div>
  );
}
