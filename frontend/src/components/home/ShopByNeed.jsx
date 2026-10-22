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

  const allCount = Object.values(categories).reduce((sum, c) => sum + c.count, 0);

  return (
    <section className="shop-by-need" aria-label="Shop by need">
      <Link to="/products" className="shop-all-banner panel">
        <span className="need-icon"><Icon name="grid" size={22} /></span>
        <span className="shop-all-text">
          <strong>Shop all products</strong>
          <span>Browse the whole store{allCount ? ` · ${allCount} products across ${Object.keys(categories).length} categories` : ''}</span>
        </span>
        <span className="btn btn-buy">Shop now <Icon name="arrowRight" size={16} /></span>
      </Link>
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
                <Link key={id} to={id === 'grocery' ? '/grocery' : `/products?category=${id}`} className="need-tile">
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
