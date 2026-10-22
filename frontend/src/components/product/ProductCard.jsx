import { Link } from 'react-router-dom';
import { useCart } from '../../context/CartContext';
import { useWishlist } from '../../context/WishlistContext';
import useShopActions from '../../hooks/useShopActions';
import Icon from '../common/Icon';
import Price from '../common/Price';
import Rating from '../common/Rating';

// variant "grid" = listing pages, "compact" = horizontal home-page rails
export default function ProductCard({ product, variant = 'grid' }) {
  const { has: inCart } = useCart();
  const { has: inWishlist } = useWishlist();
  const { addToCart, toggleWishlist } = useShopActions();
  const outOfStock = product.stock === 0;
  const wished = inWishlist(product._id);

  return (
    <article className={`product-card product-card-${variant}`}>
      <button
        type="button"
        className={`wish-btn ${wished ? 'active' : ''}`}
        onClick={() => toggleWishlist(product)}
        aria-label={wished ? 'Remove from wishlist' : 'Add to wishlist'}
        aria-pressed={wished}
      >
        <Icon name="heart" size={16} filled={wished} />
      </button>

      <Link to={`/products/${product._id}`} className="product-link">
        <div className="product-img">
          <img src={product.image} alt={product.name} loading="lazy" />
          {outOfStock && <span className="stock-flag">Sold out</span>}
          {product.images360?.length >= 4 && <span className="badge-360"><Icon name="rotate" size={11} /> 360°</span>}
        </div>
        <div className="product-info">
          {product.brand && <p className="product-brand">{product.brand}</p>}
          <h3 className="product-name">{product.name}</h3>
          {product.rating > 0 && <Rating value={product.rating} count={product.ratingCount} size="sm" />}
          <Price price={product.price} mrp={product.mrp} size="sm" />
          {variant === 'grid' && product.price >= 499 && <p className="product-perk">Free delivery</p>}
        </div>
      </Link>

      {variant === 'grid' && (
        inCart(product._id) ? (
          <Link to="/cart" className="btn btn-outline btn-block btn-sm"><Icon name="cart" size={14} /> Go to cart</Link>
        ) : (
          <button type="button" className="btn btn-cart btn-block btn-sm" disabled={outOfStock} onClick={() => addToCart(product)}>
            <Icon name="cart" size={14} /> {outOfStock ? 'Out of stock' : 'Add to cart'}
          </button>
        )
      )}
    </article>
  );
}
