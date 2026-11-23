import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { categoryLabel } from '../../constants/catalog';
import { productPath } from '../../hooks/useSeo';
import { formatPrice } from '../../utils/format';
import { responsiveImage } from '../../utils/image';
import Icon from '../common/Icon';

// Square packshots read best on the grey tiles (fashion photos are tall model shots), in this order of preference
const TILE_CATEGORIES = ['electronics', 'mobiles', 'accessories', 'beauty', 'home', 'sports', 'kitchen'];

/** The most popular in-stock product of each of the first three categories that have one, straight from the catalog. */
function pickTiles(products) {
  return TILE_CATEGORIES
    .map((c) => products.find((p) => p.category === c && p.stock > 0))
    .filter(Boolean)
    .slice(0, 3);
}

// Top of the home page: the promise in a sentence, one clear action, and three real products to start from
export default function HomeHero() {
  const [tiles, setTiles] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.products({ sort: 'popularity', limit: 40 })
      .then((products) => !cancelled && setTiles(pickTiles(products)))
      .catch(() => !cancelled && setTiles([])); // the headline and links still work without the tiles
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="home-hero" aria-labelledby="home-hero-title">
      <div className="home-hero-head">
        <div className="home-hero-copy">
          <p className="home-hero-eyebrow"><Icon name="truck" size={14} /> Delivering across India</p>
          <h2 id="home-hero-title" className="home-hero-title">Shop beyond limits.<br />Everyday essentials, delivered.</h2>
          <p className="home-hero-text">Mobiles, electronics, fashion, beauty, home and groceries in one place. Free delivery from ₹499, and easy 7-day returns.</p>
        </div>
        <div className="home-hero-actions">
          <Link to="/products" className="btn btn-dark btn-lg">Browse all products <Icon name="arrowRight" size={18} /></Link>
          <Link to="/products?sort=popularity" className="btn btn-ghost btn-lg">See what’s popular</Link>
        </div>
      </div>
      {tiles?.length !== 0 && (
        <div className="home-hero-tiles">
          {(tiles || Array.from({ length: 3 }, () => null)).map((p, i) => (p ? (
            <Link key={p._id} to={productPath(p)} className="hero-tile">
              <span className="hero-tile-tag">{categoryLabel(p.category)}</span>
              <span className="hero-tile-img">
                <img {...responsiveImage(p.image)} alt={p.name} width="400" height="400" loading={i === 0 ? 'eager' : 'lazy'} fetchpriority={i === 0 ? 'high' : undefined} decoding="async" />
              </span>
              <span className="hero-tile-foot">
                <span className="hero-tile-name">{p.name}</span>
                <span className="hero-tile-price">{formatPrice(p.price)}</span>
              </span>
            </Link>
          ) : (
            <div key={i} className="hero-tile skeleton" aria-hidden="true"><span className="hero-tile-img skeleton-box" /><span className="skeleton-box line" /></div>
          )))}
        </div>
      )}
    </section>
  );
}
