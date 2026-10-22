import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { CATEGORY_GROUPS, categoryLabel } from '../../constants/catalog';
import Icon from '../common/Icon';

// The whole catalog in two halves: things you buy every day, and everything else
export default function ShopByNeed() {
  const [categories, setCategories] = useState({});

  useEffect(() => {
    api.categories()
      .then((rows) => setCategories(Object.fromEntries(rows.map((r) => [r.id, r]))))
      .catch(() => setCategories({}));
  }, []);

  return (
    <section className="shop-by-need" aria-label="Shop by need">
      {CATEGORY_GROUPS.map((g) => {
        const total = g.categories.reduce((sum, id) => sum + (categories[id]?.count || 0), 0);
        return (
          <div key={g.id} className={`need-card panel need-${g.id}`}>
            <header>
              <span className="need-icon"><Icon name={g.icon} size={22} /></span>
              <div>
                <h2>{g.label}</h2>
                <p>{g.note}</p>
              </div>
              <Link to={`/products?use=${g.id}`} className="btn btn-primary btn-sm">
                View all{total ? ` ${total}` : ''} <Icon name="chevronRight" size={14} />
              </Link>
            </header>
            <div className="need-grid">
              {g.categories.map((id) => (
                <Link key={id} to={`/products?category=${id}`} className="need-tile">
                  <span className="need-img">{categories[id]?.image && <img src={categories[id].image} alt="" loading="lazy" />}</span>
                  <strong>{categoryLabel(id)}</strong>
                  {categories[id] && <small>{categories[id].count} items</small>}
                </Link>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
