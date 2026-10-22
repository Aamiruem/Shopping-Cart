import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { CATEGORIES } from '../../constants/catalog';
import Icon from '../common/Icon';
import { isSellerRole } from './Navbar';

const COLUMNS = [
  { title: 'Shop', links: CATEGORIES.slice(0, 6).map((c) => ({ label: c.label, to: `/products?category=${c.id}` })) },
  {
    title: 'Your Account',
    links: [
      { label: 'My Profile', to: '/account' },
      { label: 'Orders', to: '/orders' },
      { label: 'Wishlist', to: '/wishlist' },
      { label: 'Cart', to: '/cart' },
    ],
  },
  {
    title: 'Seller Hub',
    sellersOnly: true, // shoppers never see the seller side of the store
    links: [
      { label: 'Dashboard', to: '/seller/dashboard' },
      { label: 'List products', to: '/seller/products' },
      { label: 'Seller orders', to: '/seller/orders' },
    ],
  },
  {
    title: 'Help',
    links: [
      { label: 'Payments', to: '/help#payments' },
      { label: 'Shipping', to: '/help#shipping' },
      { label: 'Cancellation & Returns', to: '/help#returns' },
      { label: 'FAQ', to: '/help' },
    ],
  },
];

const PROMISES = [
  { icon: 'truck', title: 'Free Delivery', text: 'On orders above ₹499' },
  { icon: 'returns', title: '7-Day Returns', text: 'Easy, no-questions returns' },
  { icon: 'shield', title: 'Secure Payments', text: 'UPI, cards & cash on delivery' },
  { icon: 'headphones', title: '24×7 Support', text: 'Ask our shopping assistant' },
];

export default function Footer() {
  const { user } = useAuth();
  const columns = COLUMNS.filter((c) => !c.sellersOnly || isSellerRole(user));
  return (
    <footer className="footer">
      <div className="footer-promises container">
        {PROMISES.map((p) => (
          <div key={p.title} className="promise">
            <Icon name={p.icon} size={26} strokeWidth={1.6} />
            <div><strong>{p.title}</strong><span>{p.text}</span></div>
          </div>
        ))}
      </div>

      <div className="footer-main container">
        {columns.map((col) => (
          <div key={col.title} className="footer-col">
            <h4>{col.title}</h4>
            {col.links.map((l) => <Link key={l.label} to={l.to}>{l.label}</Link>)}
          </div>
        ))}
        <div className="footer-col footer-contact">
          <h4>Contact Us</h4>
          <p>Arvixa Retail Pvt. Ltd.<br />Outer Ring Road, Bengaluru,<br />Karnataka 560103, India</p>
          <a href="mailto:support@arvixa.example"><Icon name="mail" size={14} /> support@arvixa.example</a>
        </div>
      </div>

      <div className="footer-bottom">
        <div className="container footer-bottom-inner">
          <span><Icon name="gift" size={14} /> Gift Cards</span>
          <span><Icon name="headphones" size={14} /> Help Center</span>
          <span>© {new Date().getFullYear()} Arvixa. All rights reserved.</span>
          <span className="pay-methods">UPI · VISA · Mastercard · RuPay · COD</span>
        </div>
      </div>
    </footer>
  );
}
