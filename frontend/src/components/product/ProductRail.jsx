import { useRef } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../common/Icon';
import ProductCard from './ProductCard';

// A home-page section with a title and a horizontally scrolling row; tone="highlight" is the coloured
// Flipkart-style band (big white cards, discount badge) used for "still looking for these?"
export default function ProductRail({ title, subtitle, products, viewAll, aside, loading, tone }) {
  const scroller = useRef(null);
  const scroll = (dir) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.8, behavior: 'smooth' });

  if (!loading && !products.length) return null;

  return (
    <section className={`rail panel ${tone ? `rail-${tone}` : ''}`}>
      <header className="rail-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {aside}
        {viewAll && <Link to={viewAll} className="btn btn-primary btn-round" aria-label={`View all ${title}`}><Icon name="chevronRight" size={18} /></Link>}
      </header>

      <div className="rail-body">
        <button type="button" className="rail-arrow left" onClick={() => scroll(-1)} aria-label="Scroll left"><Icon name="chevronLeft" /></button>
        <div className="rail-track" ref={scroller}>
          {loading
            ? Array.from({ length: 6 }, (_, i) => <div key={i} className="product-card skeleton"><div className="skeleton-box image" /><div className="skeleton-box line" /></div>)
            : products.map((p) => <ProductCard key={p._id} product={p} variant="compact" />)}
        </div>
        <button type="button" className="rail-arrow right" onClick={() => scroll(1)} aria-label="Scroll right"><Icon name="chevronRight" /></button>
      </div>
    </section>
  );
}
