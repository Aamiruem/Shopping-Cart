import { Link } from 'react-router-dom';
import Icon from '../common/Icon';

const OFFERS = [
  { icon: 'card', title: '10% Instant Discount', text: 'On credit & debit cards · Min. ₹2,999', to: '/products?sort=price_desc', theme: 'blue' },
  { icon: 'truck', title: 'Free Delivery', text: 'On every order above ₹499', to: '/products?maxPrice=2000', theme: 'green' },
  { icon: 'gift', title: 'Under ₹999 Store', text: 'Gifts, gadgets & daily needs', to: '/products?maxPrice=999&sort=popularity', theme: 'orange' },
];

export default function OfferBanners() {
  return (
    <section className="offer-banners">
      {OFFERS.map((o) => (
        <Link key={o.title} to={o.to} className={`offer-banner theme-${o.theme}`}>
          <Icon name={o.icon} size={32} strokeWidth={1.6} />
          <div><strong>{o.title}</strong><span>{o.text}</span></div>
          <Icon name="chevronRight" size={20} />
        </Link>
      ))}
    </section>
  );
}
