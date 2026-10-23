import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { categoryLabel } from '../../constants/catalog';
import Icon from '../common/Icon';

const category = (id, icon) => ({
  key: id,
  icon,
  label: categoryLabel(id),
  to: `/products?category=${id}`,
  match: (l, p) => p.get('category') === id && !p.get('audience'),
});
const audience = (id, label) => ({
  key: id,
  icon: 'user',
  label,
  to: `/products?category=fashion&audience=${id}`,
  match: (l, p) => p.get('audience') === id,
});

// Icon tab row under the header (Flipkart style). Each tab knows its link and how to tell it is the current page.
const TABS = [
  { key: 'for-you', icon: 'star', label: 'For You', to: '/', match: (l) => l.pathname === '/' },
  { key: 'all', icon: 'grid', label: 'All Products', to: '/products', match: (l, p) => l.pathname === '/products' && ![...p.keys()].some((k) => ['q', 'use', 'category', 'audience'].includes(k)) },
  category('fashion', 'shirt'),
  audience('women', 'Women'),
  audience('men', 'Men'),
  category('mobiles', 'phone'),
  category('electronics', 'monitor'),
  category('beauty', 'droplet'),
  category('home', 'sofa'),
  category('kitchen', 'coffee'),
  { key: 'grocery', icon: 'basket', label: 'Grocery', to: '/grocery', match: (l) => l.pathname === '/grocery' },
  category('accessories', 'watch'),
  category('sports', 'activity'),
];

export default function CategoryBar() {
  const location = useLocation();
  const [params] = useSearchParams();

  return (
    <nav className="category-bar" aria-label="Shop by category">
      <div className="container category-tabs">
        {TABS.map((t) => {
          const active = t.match(location, params);
          return (
            <Link key={t.key} to={t.to} className={`cat-tab ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
              <span className="cat-icon"><Icon name={t.icon} size={22} strokeWidth={1.6} /></span>
              <span className="cat-label">{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
