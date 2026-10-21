import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { EmptyState, ErrorMessage, SkeletonGrid } from '../components/common/Feedback';
import Icon from '../components/common/Icon';
import FilterSidebar from '../components/product/FilterSidebar';
import ProductCard from '../components/product/ProductCard';
import { categoryLabel, SORT_OPTIONS } from '../constants/catalog';

const FILTER_KEYS = ['q', 'category', 'brand', 'minPrice', 'maxPrice', 'minRating', 'sort'];
const EMPTY_FACETS = { brands: [], minPrice: 0, maxPrice: 0 };

// Search results + category listing. All filter state lives in the URL so it is shareable.
export default function Products() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) || ''])), [params]);
  const [products, setProducts] = useState([]);
  const [facets, setFacets] = useState(EMPTY_FACETS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    api.products(filters)
      .then(setProducts)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(load, [load]);

  useEffect(() => {
    api.facets({ q: filters.q, category: filters.category }).then(setFacets).catch(() => setFacets(EMPTY_FACETS));
  }, [filters.q, filters.category]);

  const update = (patch) => {
    const next = { ...filters, ...patch };
    setParams(Object.fromEntries(Object.entries(next).filter(([, v]) => v !== '' && v != null)));
  };
  const clear = () => setParams(filters.q ? { q: filters.q } : {});

  const heading = filters.q ? `Results for “${filters.q}”` : filters.category ? categoryLabel(filters.category) : 'All Products';

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
          <h1>{heading} <small>({loading ? '…' : products.length} items)</small></h1>
          <button type="button" className="btn btn-outline btn-sm filters-toggle" onClick={() => setFiltersOpen(true)}>
            <Icon name="filter" size={14} /> Filters
          </button>
        </div>

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
          <div className="product-grid">{products.map((p) => <ProductCard key={p._id} product={p} />)}</div>
        ) : (
          !error && (
            <EmptyState
              icon="search"
              title="Sorry, no results found!"
              message="Please check the spelling or try searching for something else."
              action={{ to: '/products', label: 'Browse all products' }}
            />
          )
        )}
      </section>
    </div>
  );
}
