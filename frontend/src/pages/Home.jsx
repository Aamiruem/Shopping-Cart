import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { ErrorMessage } from '../components/common/Feedback';
import DealTimer from '../components/home/DealTimer';
import FestiveStore from '../components/home/FestiveStore';
import HeroCarousel from '../components/home/HeroCarousel';
import OfferBanners from '../components/home/OfferBanners';
import PromoVideo from '../components/home/PromoVideo';
import QuickLinks from '../components/home/QuickLinks';
import SeasonCollections from '../components/home/SeasonCollections';
import ShopByNeed from '../components/home/ShopByNeed';
import ProductRail from '../components/product/ProductRail';
import { useAuth } from '../context/AuthContext';
import { PREVIEW } from '../config';
import useSeo, { homeLd } from '../hooks/useSeo';
import { homeDescription, SITE_NAME } from '../seo/copy';
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

const FASHION_FIRST = ['women', 'men'];
const LATER_RAILS = RAILS.filter((r) => !FASHION_FIRST.includes(r.key));

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

function LoadedRail({ params, ...rail }) {
  const { products, loading } = useProducts(params);
  return <ProductRail {...rail} products={products} loading={loading} />;
}

// Rails further down the page show a placeholder until a shopper scrolls near them
function Rail({ title, subtitle, params }) {
  const slot = useRef(null);
  const [nearby, setNearby] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setNearby(true);
      observer.disconnect();
    }, { rootMargin: '500px' });
    observer.observe(slot.current);
    return () => observer.disconnect();
  }, []);
  const viewAll = `/products?${new URLSearchParams({ category: params.category, ...(params.audience && { audience: params.audience }), sort: params.sort })}`;
  const rail = { title, subtitle, viewAll };
  return <div ref={slot}>{nearby ? <LoadedRail {...rail} params={params} /> : <ProductRail {...rail} products={[]} loading />}</div>;
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

export default function Home() {
  useSeo({ description: homeDescription(PREVIEW), path: '/', jsonLd: homeLd() });
  const deals = useProducts({ featured: 'true', sort: 'popularity', limit: 100 });
  const [recent] = useState(getRecentlyViewed);
  const { user } = useAuth();

  return (
    <div className="page-home container">
      <h1 className="sr-only">{SITE_NAME}: Online Shopping in India</h1>
      <QuickLinks />
      <FestiveStore />
      {/* Fashion first: women's and men's styles straight after the festive store */}
      {RAILS.filter((r) => FASHION_FIRST.includes(r.key)).map((r) => <Rail key={r.key} {...r} />)}
      <HeroCarousel />
      {recent.length > 0 && (
        <ProductRail tone="highlight" title={user ? `${user.name.split(' ')[0]}, still looking for these?` : 'Still looking for these?'} products={recent} />
      )}
      <ShopByNeed />
      <SeasonCollections />
      <ErrorMessage message={deals.error && `Couldn't load products: ${deals.error}`} />

      <ProductRail
        title={PREVIEW ? 'Popular Picks' : 'Deals of the Day'}
        products={mixCategories(deals.products, 14)}
        loading={deals.loading}
        aside={PREVIEW ? undefined : <DealTimer />}
        viewAll="/products?sort=popularity"
      />

      <ForYou />
      {!PREVIEW && <OfferBanners />}

      {LATER_RAILS.slice(0, 2).map((r) => <Rail key={r.key} {...r} />)}
      <PromoVideo />
      {LATER_RAILS.slice(2).map((r) => <Rail key={r.key} {...r} />)}

    </div>
  );
}
