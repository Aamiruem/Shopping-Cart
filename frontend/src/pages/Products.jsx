import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { EmptyState, ErrorMessage, SkeletonGrid } from '../components/common/Feedback';
import Icon from '../components/common/Icon';
import FilterSidebar from '../components/product/FilterSidebar';
import ProductCard from '../components/product/ProductCard';
import { AUDIENCES, CATEGORY_GROUPS, categoryLabel, DEPARTMENTS, FASHION_TYPES, KIDS, SORT_OPTIONS } from '../constants/catalog';
import { PREVIEW } from '../config';
import { listingDescription, listingTitle } from '../seo/copy';
import { trackSearch } from '../utils/analytics';
import usePageTint from '../hooks/usePageTint';
import useSeo, { breadcrumbLd, itemListLd } from '../hooks/useSeo';

const PAGE_SIZE = 48;
const FILTER_KEYS = ['q', 'use', 'category', 'audience', 'subCategory', 'brand', 'minPrice', 'maxPrice', 'minRating', 'sort'];
const EMPTY_FACETS = { brands: [], minPrice: 0, maxPrice: 0 };

// Search results + category listing. All filter state lives in the URL so it is shareable.
export default function Products() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) || ''])), [params]);
  usePageTint(filters.audience && filters.category === 'fashion' ? filters.audience : filters.category);
  const [products, setProducts] = useState([]);
  const [facets, setFacets] = useState(EMPTY_FACETS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const moreRef = useRef(null);

  // First page; more arrive as the shopper scrolls (or presses Load more)
  const load = useCallback(() => {
    setLoading(true);
    setError('');
    api.products({ ...filters, limit: PAGE_SIZE })
      .then((page) => {
        setProducts(page);
        setHasMore(page.length === PAGE_SIZE);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(load, [load]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    api.products({ ...filters, limit: PAGE_SIZE, skip: products.length })
      .then((page) => {
        setProducts((list) => [...list, ...page.filter((p) => !list.some((x) => x._id === p._id))]);
        setHasMore(page.length === PAGE_SIZE);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoadingMore(false));
  }, [filters, products.length, hasMore, loadingMore]);

  // Infinite scroll: load the next page a screen before the end of the grid
  useEffect(() => {
    const target = moreRef.current;
    if (!target || !hasMore) return undefined;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && loadMore(), { rootMargin: '800px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  useEffect(() => {
    if (filters.q) trackSearch(filters.q);
  }, [filters.q]);

  useEffect(() => {
    api.facets({ q: filters.q, use: filters.use, category: filters.category, audience: filters.audience }).then(setFacets).catch(() => setFacets(EMPTY_FACETS));
  }, [filters.q, filters.use, filters.category, filters.audience]);

  const update = (patch) => {
    const next = { ...filters, ...patch };
    setParams(Object.fromEntries(Object.entries(next).filter(([, v]) => v !== '' && v != null)));
  };
  const clear = () => setParams(filters.q ? { q: filters.q } : {});

  const audience = [...AUDIENCES, KIDS].find((a) => a.id === filters.audience);
  const group = CATEGORY_GROUPS.find((g) => g.id === filters.use);
  const heading = filters.q
    ? `Results for “${filters.q}”`
    : audience && filters.category === 'fashion'
      ? audience.heading
      : filters.category ? categoryLabel(filters.category) : group ? group.label : 'All Products';

  // Filtered / sorted variants point search engines at the clean category URL
  const canonical = filters.q ? `/products?q=${encodeURIComponent(filters.q)}`
    : `/products${filters.category ? `?category=${filters.category}${filters.audience ? `&audience=${filters.audience}` : ''}` : filters.use ? `?use=${filters.use}` : ''}`;
  useSeo({
    title: filters.q ? `Search results for ${filters.q}` : listingTitle(heading, PREVIEW),
    description: listingDescription(heading.replace(/[“”]/g, ''), products.length, PREVIEW),
    path: canonical,
    // Search results and filtered views are thin duplicates of the category pages
    noindex: Boolean(filters.q || filters.subCategory || filters.brand || filters.minPrice || filters.maxPrice || filters.minRating),
    jsonLd: [breadcrumbLd([{ name: 'Home', path: '/' }, { name: heading.replace(/[“”]/g, ''), path: canonical }]), ...(products.length ? [itemListLd(products)] : [])],
  });

  return (
    <div className="page-listing container">
      <FilterSidebar
        filters={filters}
        facets={facets}
        onChange={update}
        onClear={clear}
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
      />
      {filtersOpen && <div className="backdrop" onClick={() => setFiltersOpen(false)} />}

      <section className="listing panel">
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <Link to="/">Home</Link> <Icon name="chevronRight" size={12} />
          <span>{heading}</span>
        </nav>
        <div className="listing-head">
          <h1>{heading} <small>({loading ? '…' : `${products.length}${hasMore ? '+' : ''}`} items)</small></h1>
          <button type="button" className="btn btn-outline btn-sm filters-toggle" onClick={() => setFiltersOpen(true)}>
            <Icon name="filter" size={14} /> Filters
          </button>
        </div>

        {!filters.category && !filters.q && !filters.use && (
          <nav className="departments" aria-label="Shop by department">
            {DEPARTMENTS.map((d) => (
              <Link key={d.label} to={d.to} className="department" style={{ '--dept': d.color }}>
                <span className="department-icon"><Icon name={d.icon} size={22} /></span>
                <span>{d.label}</span>
              </Link>
            ))}
          </nav>
        )}

        {filters.category === 'fashion' && (
          <nav className="type-chips" aria-label="Shop by type">
            {FASHION_TYPES.map((t) => {
              const active = Object.entries(t.params).every(([k, v]) => filters[k] === v);
              return (
                <button
                  key={t.label}
                  type="button"
                  className={active ? 'active' : ''}
                  aria-pressed={active}
                  onClick={() => update(active ? { q: '', subCategory: '' } : { q: '', subCategory: '', brand: '', ...t.params })}
                >
                  {t.label}
                </button>
              );
            })}
          </nav>
        )}

        <div className="sort-tabs" role="tablist" aria-label="Sort by">
          <span>Sort By</span>
          {SORT_OPTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={(filters.sort || 'relevance') === s.id}
              className={(filters.sort || 'relevance') === s.id ? 'active' : ''}
              onClick={() => update({ sort: s.id === 'relevance' ? '' : s.id })}
            >
              {s.label}
            </button>
          ))}
        </div>

        <ErrorMessage message={error} onRetry={load} />
        {loading ? (
          <SkeletonGrid />
        ) : products.length ? (
          <>
            <div className="product-grid">{products.map((p) => <ProductCard key={p._id} product={p} />)}</div>
            {hasMore && (
              <div ref={moreRef} className="load-more">
                <button type="button" className="btn btn-outline" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Load more products'}
                </button>
              </div>
            )}
          </>
        ) : (
          !error && (
            ['boys', 'girls', 'kids'].includes(filters.audience) ? (
              <EmptyState
                icon="shirt"
                title={`${audience?.label ?? 'Kids'}’ clothing is coming soon`}
                message="We’re adding styles for children. Meanwhile, have a look at the rest of our fashion."
                action={{ to: '/products?category=fashion', label: 'Shop all fashion' }}
              />
            ) : (
              <EmptyState
                icon="search"
                title="Sorry, no results found!"
                message="Please check the spelling or try searching for something else."
                action={{ to: '/products', label: 'Browse all products' }}
              />
            )
          )
        )}
      </section>
    </div>
  );
}
