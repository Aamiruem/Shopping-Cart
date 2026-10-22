import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { ErrorMessage } from '../components/common/Feedback';
import DealTimer from '../components/home/DealTimer';
import HeroCarousel from '../components/home/HeroCarousel';
import OfferBanners from '../components/home/OfferBanners';
import PromoVideo from '../components/home/PromoVideo';
import QuickLinks from '../components/home/QuickLinks';
import SeasonCollections from '../components/home/SeasonCollections';
import ShopByNeed from '../components/home/ShopByNeed';
import ProductRail from '../components/product/ProductRail';
import { useAuth } from '../context/AuthContext';
import useSeo from '../hooks/useSeo';
import { getRecentlyViewed } from '../utils/recentlyViewed';

// Each rail is one API call; they load independently so one failure doesn't blank the page
const RAILS = [
  { key: 'mobiles', title: 'Best of Mobiles', subtitle: 'Top picks from popular brands', params: { category: 'mobiles', sort: 'popularity', limit: 12 } },
  { key: 'electronics', title: 'Electronics & Accessories', subtitle: 'Laptops, tablets & more', params: { category: 'electronics', sort: 'rating', limit: 12 } },
  { key: 'women', title: "Women's Fashion", subtitle: 'Dresses, tops, jackets & heels · Many in 360° view', params: { category: 'fashion', audience: 'women', sort: 'popularity', limit: 12 } },
  { key: 'men', title: "Men's Fashion", subtitle: 'Shirts, tees, jackets & sneakers · Many in 360° view', params: { category: 'fashion', audience: 'men', sort: 'popularity', limit: 12 } },
  { key: 'beauty', title: 'Beauty & Fragrances', params: { category: 'beauty', sort: 'rating', limit: 12 } },
  { key: 'kitchen', title: 'Home & Kitchen Essentials', params: { category: 'kitchen', sort: 'popularity', limit: 12 } },
];

function useProducts(params) {
  const [state, setState] = useState({ products: [], loading: true, error: '' });
  const key = JSON.stringify(params);
  useEffect(() => {
    let cancelled = false;
    api.products(params)
      .then((products) => !cancelled && setState({ products, loading: false, error: '' }))
      .catch((err) => !cancelled && setState({ products: [], loading: false, error: err.message }));
    return () => {
      cancelled = true;
    };
  }, [key]); // `params` is a fresh object each render; its JSON key is the stable dependency
  return state;
}

// Round-robin across categories so one category can't fill the whole deals rail
function mixCategories(products, max) {
  const buckets = {};
  products.forEach((p) => (buckets[p.category] ||= []).push(p));
  const queues = Object.values(buckets);
  const mixed = [];
  while (mixed.length < max && queues.some((q) => q.length)) {
    queues.forEach((q) => q.length && mixed.length < max && mixed.push(q.shift()));
  }
  return mixed;
}

function Rail({ title, subtitle, params }) {
  const { products, loading } = useProducts(params);
  return <ProductRail title={title} subtitle={subtitle} products={products} loading={loading} viewAll={`/products?${new URLSearchParams({ category: params.category, ...(params.audience && { audience: params.audience }), sort: params.sort })}`} />;
}

// Collaborative-filtering picks for logged-in shoppers, trending products for everyone else
function ForYou() {
  const { user } = useAuth();
  const [state, setState] = useState({ items: [], strategy: '', loading: true });
  useEffect(() => {
    let cancelled = false;
    api.forYou()
      .then((r) => !cancelled && setState({ ...r, loading: false }))
      .catch(() => !cancelled && setState({ items: [], strategy: '', loading: false }));
    return () => {
      cancelled = true;
    };
  }, [user?.id]);
  const personal = state.strategy === 'personalised';
  return (
    <ProductRail
      title={personal ? `Recommended for you${user ? `, ${user.name.split(' ')[0]}` : ''}` : 'Trending now'}
      subtitle={personal ? 'Picked by our AI from what you browse and buy' : 'What shoppers are loving this week'}
      products={state.items}
      loading={state.loading}
    />
  );
}

const HOME_LD = [
  { '@type': 'Organization', name: 'Arvixa', url: '/', logo: '/brand/arvixa-mark-192.png', slogan: 'Shop Beyond Limits' },
  {
    '@type': 'WebSite',
    name: 'Arvixa',
    url: '/',
    potentialAction: { '@type': 'SearchAction', target: '/products?q={search_term_string}', 'query-input': 'required name=search_term_string' },
  },
];

export default function Home() {
  useSeo({
    description: 'Shop online at Arvixa: mobiles, electronics, fashion for women and men, groceries, beauty, home and kitchen. Best prices, free delivery over ₹499, UPI, cards and cash on delivery.',
    path: '/',
    jsonLd: HOME_LD.map((x) => ({ ...x, url: window.location.origin + x.url, ...(x.logo ? { logo: window.location.origin + x.logo } : {}),
      ...(x.potentialAction ? { potentialAction: { ...x.potentialAction, target: window.location.origin + x.potentialAction.target } } : {}) })),
  });
  const deals = useProducts({ featured: 'true', sort: 'popularity', limit: 100 });
  const [recent] = useState(getRecentlyViewed);

  return (
    <div className="page-home container">
      <QuickLinks />
      <HeroCarousel />
      <ShopByNeed />
      <SeasonCollections />
      <ErrorMessage message={deals.error && `Couldn't load products: ${deals.error}`} />

      <ProductRail
        title="Deals of the Day"
        products={mixCategories(deals.products, 14)}
        loading={deals.loading}
        aside={<DealTimer />}
        viewAll="/products?sort=popularity"
      />

      <ForYou />
      <OfferBanners />

      {RAILS.slice(0, 3).map((r) => <Rail key={r.key} {...r} />)}
      <PromoVideo />
      {RAILS.slice(3).map((r) => <Rail key={r.key} {...r} />)}

      {recent.length > 0 && <ProductRail title="Recently Viewed" products={recent} />}
    </div>
  );
}
