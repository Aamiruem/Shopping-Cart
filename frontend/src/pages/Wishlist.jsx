import { Link } from 'react-router-dom';
import { EmptyState } from '../components/common/Feedback';
import Icon from '../components/common/Icon';
import Price from '../components/common/Price';
import Rating from '../components/common/Rating';
import { useWishlist } from '../context/WishlistContext';
import useShopActions from '../hooks/useShopActions';

export default function Wishlist() {
  const { items } = useWishlist();
  const { addToCart, toggleWishlist } = useShopActions();

  if (!items.length) {
    return (
      <div className="container">
        <EmptyState icon="heart" title="Your wishlist is empty" message="Save items you like and buy them later." action={{ to: '/products', label: 'Explore products' }} />
      </div>
    );
  }

  return (
    <div className="page-orders container narrow">
      <div className="panel">
        <h1 className="panel-title">My Wishlist ({items.length})</h1>
        <ul className="wish-list">
          {items.map((p) => (
            <li key={p._id}>
              <Link to={`/products/${p._id}`} className="wish-img"><img src={p.image} alt={p.name} /></Link>
              <div className="wish-info">
                <Link to={`/products/${p._id}`}>{p.name}</Link>
                <Rating value={p.rating} count={p.ratingCount} size="sm" />
                <Price price={p.price} mrp={p.mrp} />
                {p.stock === 0 && <p className="text-error small">Currently unavailable</p>}
              </div>
              <div className="wish-actions">
                <button type="button" className="btn btn-cart btn-sm" disabled={p.stock === 0} onClick={() => addToCart(p)}>
                  <Icon name="cart" size={14} /> Add to cart
                </button>
                <button type="button" className="icon-btn" onClick={() => toggleWishlist(p)} aria-label={`Remove ${p.name} from wishlist`}>
                  <Icon name="trash" size={18} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
