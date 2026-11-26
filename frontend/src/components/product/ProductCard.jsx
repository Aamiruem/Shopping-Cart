import { responsiveImage } from '../../utils/image';
import { Link } from 'react-router-dom';
import { PREVIEW, SHOPPING } from '../../config';
import { CATEGORY_COLORS } from '../../constants/colors';
import { useCart } from '../../context/CartContext';
import { useWishlist } from '../../context/WishlistContext';
import { productPath } from '../../hooks/useSeo';
import useShopActions from '../../hooks/useShopActions';
import Icon from '../common/Icon';
import Price from '../common/Price';
import Rating, { shownRating } from '../common/Rating';
import { discountPercent } from '../../utils/format';
import { swatchOf } from './VariantPicker';

export const availabilityLabel = (p) =>
  ({ coming_soon: 'Coming soon', discontinued: 'Discontinued', unavailable: 'Currently unavailable' })[p.availability] || 'Out of stock';

// variant "grid" = listing pages, "compact" = horizontal home-page rails
export default function ProductCard({ product, variant = 'grid' }) {
  const { has: inCart } = useCart();
  const { has: inWishlist } = useWishlist();
  const { addToCart, toggleWishlist } = useShopActions();
  // The server says whether a product can be bought (verified, on sale, in stock); never guessed here
  const outOfStock = product.purchasable === false || product.stock === 0;
  const blocked = availabilityLabel(product);
  const wished = inWishlist(product._id);
  const off = discountPercent(product.price, product.mrp);
  // Clothing reads best as a full-bleed portrait photo (Flipkart / Myntra style); gadgets stay square
  const portrait = product.category === 'fashion';
  // Any product with more than one photo shows the next one on hover
  const hoverImage = product.images?.find((src) => src !== product.image);

  return (
    <article className={`product-card product-card-${variant} ${portrait ? 'product-card-portrait' : ''}`} style={{ '--card-tint': CATEGORY_COLORS[product.category] }}>
      {SHOPPING && (
      <button
        type="button"
        className={`wish-btn ${wished ? 'active' : ''}`}
        onClick={() => toggleWishlist(product)}
        aria-label={wished ? 'Remove from wishlist' : 'Add to wishlist'}
        aria-pressed={wished}
      >
        <Icon name="heart" size={16} filled={wished} />
      </button>
      )}

      <Link to={productPath(product)} className="product-link">
        <div className="product-img">
          <img {...responsiveImage(product.image)} alt={product.name} loading="lazy" decoding="async" />
          {hoverImage && <img className="product-img-alt" {...responsiveImage(hoverImage)} alt="" loading="lazy" decoding="async" aria-hidden="true" />}
          {outOfStock && <span className="stock-flag">{blocked === 'Out of stock' ? 'Sold out' : blocked}</span>}
          {!PREVIEW && off >= 10 && <span className="off-badge" aria-hidden="true">↓{off}%</span>}
          {product.images360?.length >= 4 && <span className="badge-360"><Icon name="rotate" size={11} /> 360°</span>}
        </div>
        <div className="product-info">
          {product.brand && <p className="product-brand">{product.brand}</p>}
          <h3 className="product-name">{product.name}</h3>
          {product.unit && <p className="product-unit">{product.unit}</p>}
          {shownRating(product).count > 0 && <Rating value={shownRating(product).value} count={shownRating(product).count} size="sm" />}
          <Price price={product.price} mrp={product.mrp} size="sm" />
          {product.colors?.length > 0 && (
            <p className="card-swatches" aria-label={`${product.colors.length} colour${product.colors.length > 1 ? 's' : ''}: ${product.colors.join(', ')}`}>
              {product.colors.slice(0, 5).map((c) => <span key={c} style={{ background: swatchOf(product, c) || 'var(--border)' }} title={c} />)}
              {product.colors.length > 5 && <small>+{product.colors.length - 5}</small>}
            </p>
          )}
          {!PREVIEW && variant === 'grid' && product.price >= 499 && <p className="product-perk">Free delivery</p>}
        </div>
      </Link>

      {variant === 'grid' && (
        inCart(product._id) ? (
          <Link to="/cart" className="btn btn-outline btn-block btn-sm"><Icon name="cart" size={14} /> Go to cart</Link>
        ) : product.sizes?.length > 1 && SHOPPING && !outOfStock ? (
          // Sizes are chosen on the product page (with the size guide), not guessed here
          <Link to={productPath(product)} className="btn btn-cart btn-block btn-sm"><Icon name="shirt" size={14} /> Select size</Link>
        ) : (
          <button type="button" className="btn btn-cart btn-block btn-sm" disabled={outOfStock || !SHOPPING} onClick={() => addToCart(product, 1, { size: product.sizes?.[0], color: product.colors?.[0] })}>
            <Icon name="cart" size={14} /> {!SHOPPING ? 'Coming soon' : outOfStock ? blocked : 'Add to cart'}
          </button>
        )
      )}
    </article>
  );
}
