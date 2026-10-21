import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { EmptyState, Spinner } from '../components/common/Feedback';
import Icon from '../components/common/Icon';
import Price from '../components/common/Price';
import Rating from '../components/common/Rating';
import ProductRail from '../components/product/ProductRail';
import { categoryLabel } from '../constants/catalog';
import { useCart } from '../context/CartContext';
import { useWishlist } from '../context/WishlistContext';
import useShopActions from '../hooks/useShopActions';
import { deliveryDate } from '../utils/format';
import { addRecentlyViewed } from '../utils/recentlyViewed';

const OFFERS = [
  'Bank Offer: 10% instant discount on credit & debit cards, up to ₹1,500',
  'Special Price: Extra discount included in the price shown',
  'Free delivery on orders above ₹499',
  'No-cost EMI on orders above ₹3,000',
];

function DeliveryCheck() {
  const [pincode, setPincode] = useState('');
  const [result, setResult] = useState(null);
  const check = (e) => {
    e.preventDefault();
    setResult(/^\d{6}$/.test(pincode) ? { ok: true, text: `Delivery by ${deliveryDate(Number(pincode[0]) % 3 + 2)}` } : { ok: false, text: 'Please enter a valid 6-digit pincode' });
  };
  return (
    <form className="delivery-check" onSubmit={check}>
      <Icon name="mapPin" size={16} />
      <input value={pincode} onChange={(e) => setPincode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="Enter delivery pincode" inputMode="numeric" aria-label="Delivery pincode" />
      <button type="submit" className="btn-link">Check</button>
      {result && <p className={result.ok ? 'text-success' : 'text-error'}>{result.text}</p>}
    </form>
  );
}

export default function ProductDetail() {
  const { id } = useParams();
  const [product, setProduct] = useState(null);
  const [error, setError] = useState('');
  const [activeImage, setActiveImage] = useState(0);
  const [similar, setSimilar] = useState([]);
  const [together, setTogether] = useState({ items: [], strategy: '' });
  const { has: inCart } = useCart();
  const { has: inWishlist } = useWishlist();
  const { addToCart, buyNow, toggleWishlist } = useShopActions();

  useEffect(() => {
    let cancelled = false;
    setProduct(null);
    setError('');
    setActiveImage(0);
    setSimilar([]);
    setTogether({ items: [], strategy: '' });
    api.together(id).then((r) => !cancelled && setTogether(r)).catch(() => {});

    api.product(id)
      .then((p) => {
        if (cancelled) return;
        setProduct(p);
        addRecentlyViewed(p);
        // AI recommendations first; fall back to the same category if the AI service is down
        return api.recommend(id)
          .then((recs) => (recs?.length ? recs : Promise.reject()))
          .catch(() => api.products({ category: p.category, sort: 'popularity', limit: 13 }))
          .then((list) => !cancelled && setSimilar(list.filter((x) => x._id !== id)));
      })
      .catch((err) => !cancelled && setError(err.message));

    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) return <div className="container"><EmptyState title="Product not found" message={error} action={{ to: '/products', label: 'Continue shopping' }} /></div>;
  if (!product) return <Spinner />;

  const images = product.images?.length ? product.images : [product.image];
  const outOfStock = product.stock === 0;
  const wished = inWishlist(product._id);

  return (
    <div className="page-detail container">
      <div className="detail panel">
        <div className="detail-gallery">
          <div className="thumbs">
            {images.map((src, i) => (
              <button key={src} type="button" className={i === activeImage ? 'active' : ''} onMouseEnter={() => setActiveImage(i)} onClick={() => setActiveImage(i)} aria-label={`Image ${i + 1}`}>
                <img src={src} alt="" />
              </button>
            ))}
          </div>
          <div className="main-image">
            <img src={images[activeImage]} alt={product.name} />
            <button type="button" className={`wish-btn large ${wished ? 'active' : ''}`} onClick={() => toggleWishlist(product)} aria-label={wished ? 'Remove from wishlist' : 'Add to wishlist'}>
              <Icon name="heart" size={20} filled={wished} />
            </button>
          </div>
          <div className="detail-actions">
            {inCart(product._id) ? (
              <Link to="/cart" className="btn btn-cart btn-lg"><Icon name="cart" size={18} /> Go to cart</Link>
            ) : (
              <button type="button" className="btn btn-cart btn-lg" disabled={outOfStock} onClick={() => addToCart(product)}>
                <Icon name="cart" size={18} /> Add to cart
              </button>
            )}
            <button type="button" className="btn btn-buy btn-lg" disabled={outOfStock} onClick={() => buyNow(product)}>
              <Icon name="zap" size={18} filled /> Buy now
            </button>
          </div>
        </div>

        <div className="detail-info">
          <nav className="breadcrumbs" aria-label="Breadcrumb">
            <Link to="/">Home</Link> <Icon name="chevronRight" size={12} />
            <Link to={`/products?category=${product.category}`}>{categoryLabel(product.category)}</Link> <Icon name="chevronRight" size={12} />
            <span>{product.brand}</span>
          </nav>
          {product.brand && <p className="detail-brand">{product.brand}</p>}
          <h1>{product.name}</h1>
          <div className="detail-rating">
            <Rating value={product.rating} />
            <span className="muted">{product.ratingCount?.toLocaleString('en-IN')} ratings</span>
            {product.featured && <span className="assured"><Icon name="shield" size={12} /> Veyra Assured</span>}
          </div>
          {product.discount > 0 && <p className="text-success special">Special price</p>}
          <Price price={product.price} mrp={product.mrp} size="lg" />
          <p className={`stock ${outOfStock ? 'text-error' : product.stock < 10 ? 'text-warn' : 'text-success'}`}>
            {outOfStock ? 'Currently out of stock' : product.stock < 10 ? `Hurry, only ${product.stock} left!` : 'In stock'}
          </p>

          <div className="detail-section">
            <h3>Available offers</h3>
            <ul className="offer-list">
              {OFFERS.map((o) => <li key={o}><Icon name="tag" size={14} /> {o}</li>)}
            </ul>
          </div>

          <div className="detail-section detail-grid">
            <h3>Delivery</h3>
            <div>
              <DeliveryCheck />
              <p className="muted small">Usually delivered in 2–4 days · Cash on delivery available</p>
            </div>
          </div>

          <div className="detail-section detail-grid">
            <h3>Services</h3>
            <ul className="service-list">
              <li><Icon name="returns" size={16} /> 7-day return policy</li>
              <li><Icon name="truck" size={16} /> {product.price >= 499 ? 'Free delivery' : '₹40 delivery charge'}</li>
              <li><Icon name="shield" size={16} /> 1-year warranty on eligible products</li>
            </ul>
          </div>

          <div className="detail-section">
            <h3>Product description</h3>
            <p className="description">{product.description}</p>
            <table className="spec-table">
              <tbody>
                <tr><th>Brand</th><td>{product.brand || '—'}</td></tr>
                <tr><th>Category</th><td>{categoryLabel(product.category)}</td></tr>
                {product.tags?.length > 0 && <tr><th>Tags</th><td>{product.tags.join(', ')}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <ProductRail
        title={together.strategy === 'bought_together' ? 'Frequently bought together' : 'Customers also viewed'}
        subtitle="Based on what other shoppers bought and browsed"
        products={together.items}
      />
      <ProductRail title="Similar products" subtitle="You may also like" products={similar} viewAll={`/products?category=${product.category}`} />
    </div>
  );
}
