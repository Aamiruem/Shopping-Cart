import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { EmptyState, ErrorMessage, SkeletonGrid } from '../components/common/Feedback';
import Icon from '../components/common/Icon';
import ProductCard from '../components/product/ProductCard';
import ProductRail from '../components/product/ProductRail';
import { aisleLabel, GROCERY_AISLES, SORT_OPTIONS } from '../constants/catalog';
import useSeo, { breadcrumbLd } from '../hooks/useSeo';

const PROMISES = [
  { icon: 'truck', text: 'Free delivery over ₹499' },
  { icon: 'returns', text: 'Easy returns on damaged items' },
  { icon: 'card', text: 'UPI, cards or cash on delivery' },
];

// Grocery store: its own page with aisles. The whole grocery range is loaded once (it is small)
// and filtered here, so switching aisles and searching are instant.
export default function Grocery() {
  const [params, setParams] = useSearchParams();
  const aisle = params.get('aisle') || '';
  const sort = params.get('sort') || 'popularity';
  const [query, setQuery] = useState(params.get('q') || '');
  const [items, setItems] = useState([]);
  const [aisles, setAisles] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = () => {
    setLoading(true);
    setError('');
    Promise.all([api.products({ category: 'grocery', sort, limit: 200 }), api.subcategories('grocery')])
      .then(([list, rows]) => {
        setItems(list);
        setAisles(Object.fromEntries(rows.map((r) => [r.id, r])));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, [sort]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch) => {
    const next = { ...Object.fromEntries(params), ...patch };
    setParams(Object.fromEntries(Object.entries(next).filter(([, v]) => v)));
  };

  const term = query.trim().toLowerCase();
  const visible = useMemo(
    () => items.filter((p) => (!aisle || p.subCategory === aisle) && (!term || `${p.name} ${p.tags?.join(' ')}`.toLowerCase().includes(term))),
    [items, aisle, term],
  );
  const showAisleRails = !aisle && !term;
  useSeo({
    title: aisle ? `${aisleLabel(aisle)} - Online Grocery` : 'Online Grocery Store - Fruits, Vegetables, Atta, Dal & Daily Essentials',
    description: `Order ${aisle ? aisleLabel(aisle).toLowerCase() : 'groceries'} online at Arvixa Fresh: Amul, Britannia, Parle, Maggi, Haldiram's and more. Best prices and free delivery over ₹499.`,
    path: aisle ? `/grocery?aisle=${aisle}` : '/grocery',
    jsonLd: breadcrumbLd([{ name: 'Home', path: '/' }, { name: 'Grocery', path: '/grocery' }, ...(aisle ? [{ name: aisleLabel(aisle), path: `/grocery?aisle=${aisle}` }] : [])]),
  });
  const byAisle = (id) => items.filter((p) => p.subCategory === id);

  return (
    <div className="page-grocery container">
      <section className="grocery-hero">
        <div>
          <p className="grocery-eyebrow"><Icon name="home" size={14} /> Arvixa Fresh</p>
          <h1>Groceries &amp; daily essentials</h1>
          <p>Fruits, vegetables, staples, snacks and household needs, all in one place.</p>
          <ul className="grocery-promises">
            {PROMISES.map((p) => <li key={p.text}><Icon name={p.icon} size={16} /> {p.text}</li>)}
          </ul>
        </div>
        <form className="grocery-search" onSubmit={(e) => { e.preventDefault(); set({ q: query.trim() }); }} role="search">
          <Icon name="search" size={18} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search groceries: atta, milk, dal…" aria-label="Search groceries" />
          {query && <button type="button" onClick={() => { setQuery(''); set({ q: '' }); }} aria-label="Clear search"><Icon name="x" size={16} /></button>}
        </form>
      </section>

      <section className="panel grocery-aisles" aria-label="Aisles">
        <button type="button" className={`aisle-tile ${!aisle ? 'active' : ''}`} onClick={() => set({ aisle: '' })}>
          <span className="aisle-img aisle-all"><Icon name="grid" size={26} /></span>
          <strong>All groceries</strong>
          <small>{items.length || '…'} items</small>
        </button>
        {GROCERY_AISLES.filter((a) => aisles[a.id]).map((a) => (
          <button key={a.id} type="button" className={`aisle-tile ${aisle === a.id ? 'active' : ''}`} onClick={() => set({ aisle: a.id })} aria-pressed={aisle === a.id}>
            <span className="aisle-img"><img src={aisles[a.id].image} alt="" loading="lazy" /></span>
            <strong>{a.label}</strong>
            <small>{aisles[a.id].count} items</small>
          </button>
        ))}
      </section>

      <ErrorMessage message={error} onRetry={load} />

      {showAisleRails && !loading ? (
        GROCERY_AISLES.filter((a) => aisles[a.id]).map((a) => (
          <ProductRail key={a.id} title={a.label} subtitle={`${aisles[a.id].count} items`} products={byAisle(a.id)} viewAll={`/grocery?aisle=${a.id}`} />
        ))
      ) : (
        <section className="panel listing">
          <div className="listing-head grocery-listing-head">
            <h2>{term ? `Results for “${query.trim()}”` : aisle ? aisleLabel(aisle) : 'All groceries'} <small>({loading ? '…' : visible.length} items)</small></h2>
            <label className="grocery-sort">Sort by
              <select className="select-sm" value={sort} onChange={(e) => set({ sort: e.target.value })}>
                {SORT_OPTIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
          </div>
          {loading ? <SkeletonGrid /> : visible.length ? (
            <div className="product-grid">{visible.map((p) => <ProductCard key={p._id} product={p} />)}</div>
          ) : (
            <EmptyState icon="search" title="No groceries found" message="Try another word, or browse all aisles." action={{ to: '/grocery', label: 'All groceries' }} />
          )}
        </section>
      )}

      <p className="grocery-credit muted small">
        Some grocery photos come from <a href="https://commons.wikimedia.org" target="_blank" rel="noreferrer">Wikimedia Commons</a> under
        Creative Commons licences; each product page credits its photographer. <Link to="/products">Shop all products</Link>
      </p>
    </div>
  );
}
