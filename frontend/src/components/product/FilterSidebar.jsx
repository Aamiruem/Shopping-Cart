import { useEffect, useState } from 'react';
import { CATEGORIES } from '../../constants/catalog';
import Icon from '../common/Icon';

const PRICE_PRESETS = [
  { label: 'Under ₹1,000', min: '', max: 999 },
  { label: '₹1,000 – ₹5,000', min: 1000, max: 5000 },
  { label: '₹5,000 – ₹20,000', min: 5000, max: 20000 },
  { label: 'Over ₹20,000', min: 20000, max: '' },
];

// `filters` mirrors the URL query; `onChange(patch)` merges into it
export default function FilterSidebar({ filters, facets, onChange, onClear, open, onClose }) {
  const [price, setPrice] = useState({ min: filters.minPrice || '', max: filters.maxPrice || '' });
  useEffect(() => setPrice({ min: filters.minPrice || '', max: filters.maxPrice || '' }), [filters.minPrice, filters.maxPrice]);

  const brands = filters.brand ? filters.brand.split(',') : [];
  const toggleBrand = (b) => {
    const next = brands.includes(b) ? brands.filter((x) => x !== b) : [...brands, b];
    onChange({ brand: next.join(',') });
  };

  return (
    <aside className={`filters panel ${open ? 'open' : ''}`} aria-label="Filters">
      <div className="filters-head">
        <h3>Filters</h3>
        <button type="button" className="btn-link" onClick={onClear}>Clear all</button>
        <button type="button" className="filters-close" onClick={onClose} aria-label="Close filters"><Icon name="x" /></button>
      </div>

      <div className="filter-group">
        <h4>Categories</h4>
        <label className="radio-row">
          <input type="radio" name="category" checked={!filters.category} onChange={() => onChange({ category: '', brand: '' })} />
          All categories
        </label>
        {CATEGORIES.map((c) => (
          <label key={c.id} className="radio-row">
            <input type="radio" name="category" checked={filters.category === c.id} onChange={() => onChange({ category: c.id, brand: '' })} />
            {c.label}
          </label>
        ))}
      </div>

      <div className="filter-group">
        <h4>Price</h4>
        {PRICE_PRESETS.map((p) => (
          <label key={p.label} className="radio-row">
            <input
              type="radio"
              name="price"
              checked={String(filters.minPrice || '') === String(p.min) && String(filters.maxPrice || '') === String(p.max)}
              onChange={() => onChange({ minPrice: p.min, maxPrice: p.max })}
            />
            {p.label}
          </label>
        ))}
        <form className="price-inputs" onSubmit={(e) => { e.preventDefault(); onChange({ minPrice: price.min, maxPrice: price.max }); }}>
          <input type="number" min="0" placeholder={`Min${facets.minPrice ? ` (${facets.minPrice})` : ''}`} value={price.min} onChange={(e) => setPrice({ ...price, min: e.target.value })} aria-label="Minimum price" />
          <span>to</span>
          <input type="number" min="0" placeholder={`Max${facets.maxPrice ? ` (${facets.maxPrice})` : ''}`} value={price.max} onChange={(e) => setPrice({ ...price, max: e.target.value })} aria-label="Maximum price" />
          <button type="submit" className="btn btn-primary btn-sm">Go</button>
        </form>
      </div>

      <div className="filter-group">
        <h4>Customer Ratings</h4>
        {[4, 3].map((r) => (
          <label key={r} className="check-row">
            <input type="checkbox" checked={Number(filters.minRating) === r} onChange={(e) => onChange({ minRating: e.target.checked ? r : '' })} />
            {r}<Icon name="star" size={12} filled strokeWidth={0} /> & above
          </label>
        ))}
      </div>

      {facets.brands.length > 0 && (
        <div className="filter-group">
          <h4>Brand</h4>
          <div className="brand-list">
            {facets.brands.map((b) => (
              <label key={b} className="check-row">
                <input type="checkbox" checked={brands.includes(b)} onChange={() => toggleBrand(b)} />
                {b}
              </label>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
