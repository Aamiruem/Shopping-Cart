import { Link } from 'react-router-dom';
import { CLOTHING_SHORTCUTS } from '../../constants/catalog';
import Icon from '../common/Icon';

// "Shop clothing": one tap to women's, men's, boys' or girls' clothes, or straight to a type of clothing
export default function ClothingShortcuts() {
  return (
    <section className="panel clothing-shortcuts" aria-labelledby="shop-clothing">
      <div className="rail-head">
        <h2 id="shop-clothing">Shop clothing</h2>
        <Link to="/products?category=fashion" className="btn-link">All fashion <Icon name="chevronRight" size={14} /></Link>
      </div>
      <nav className="clothing-grid" aria-label="Clothing">
        {CLOTHING_SHORTCUTS.map((c) => (
          <Link key={c.label} to={c.to} className="clothing-btn" style={{ '--tone': c.color }}>
            <span className="clothing-icon"><Icon name={c.icon} size={20} /></span>
            <span>{c.label}</span>
          </Link>
        ))}
      </nav>
    </section>
  );
}
