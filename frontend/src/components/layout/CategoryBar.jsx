import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { CATEGORIES } from '../../constants/catalog';

// White strip of category tiles under the navbar (images come from the API)
export default function CategoryBar() {
  const [images, setImages] = useState({});
  const [params] = useSearchParams();
  const active = params.get('category');

  useEffect(() => {
    api.categories()
      .then((rows) => setImages(Object.fromEntries(rows.map((r) => [r.id, r.image]))))
      .catch(() => setImages({}));
  }, []);

  return (
    <nav className="category-bar" aria-label="Shop by category">
      <div className="container category-bar-inner">
        {CATEGORIES.map((c) => (
          <Link key={c.id} to={`/products?category=${c.id}`} className={`category-tile ${active === c.id ? 'active' : ''}`}>
            <span className="category-img">{images[c.id] ? <img src={images[c.id]} alt="" loading="lazy" /> : null}</span>
            <span>{c.label}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}
