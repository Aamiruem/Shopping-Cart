import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { EmptyState, Spinner } from '../components/common/Feedback';
import Icon from '../components/common/Icon';
import Price from '../components/common/Price';
import Rating, { shownRating } from '../components/common/Rating';
import ProductRail from '../components/product/ProductRail';
import BuyBox from '../components/product/BuyBox';
import Reviews from '../components/product/Reviews';
import StoreFacts from '../components/product/StoreFacts';
import Lightbox from '../components/product/Lightbox';
import Spin360 from '../components/product/Spin360';
import { aisleLabel, categoryLabel, groupOf } from '../constants/catalog';
import { useCart } from '../context/CartContext';
import { useToast } from '../context/ToastContext';
import { useWishlist } from '../context/WishlistContext';
import useShopActions from '../hooks/useShopActions';
import { deliveryDate } from '../utils/format';
import { responsiveImage } from '../utils/image';
import { PREVIEW, SHOPPING } from '../config';
import { productDescription, productTitle } from '../seo/copy';
import { trackViewItem } from '../utils/analytics';
import useSeo, { breadcrumbLd, productLd, productPath } from '../hooks/useSeo';
import { addRecentlyViewed } from '../utils/recentlyViewed';

// activeImage value that shows the 360° viewer instead of a photo
const SPIN_VIEW = -1;

const OFFERS = [
  'Bank Offer: 10% instant discount on credit & debit cards, up to ₹1,500',
  'Special Price: Extra discount included in the price shown',
  'Free delivery on orders above ₹499',
  'No-cost EMI on orders above ₹3,000',
];

// Store mode (accounts and orders on the api/ functions, sample catalog): Amazon-style buy box on the right
const STORE = PREVIEW && SHOPPING;

// The phone's share sheet where there is one, otherwise copy the link
function ShareButton({ product }) {
  const toast = useToast();
  const share = async () => {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: product.name, url });
      } catch { /* the shopper closed the share sheet */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.show('Link copied');
    } catch {
      toast.show('Couldn’t copy the link. Copy it from the address bar.', 'error');
    }
  };
  return (
    <button type="button" className="share-btn" onClick={share} aria-label={`Share ${product.name}`} title="Share">
      <Icon name="send" size={18} />
    </button>
  );
}

// Main photo that magnifies under the pointer (Flipkart-style hover zoom); touch screens just see the photo
function ZoomImage({ src, alt, onOpen }) {
  const [origin, setOrigin] = useState(null);
  const move = (e) => {
    if (e.pointerType !== 'mouse') return;
    const r = e.currentTarget.getBoundingClientRect();
    setOrigin(`${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`);
  };
  return (
    <button type="button" className={`zoom-frame ${origin ? 'zooming' : ''}`} onPointerMove={move} onPointerLeave={() => setOrigin(null)} onClick={onOpen} aria-label={`Open full view of ${alt}`}>
      <img src={src} alt={alt} style={origin ? { transformOrigin: origin } : undefined} />
    </button>
  );
}

function DeliveryCheck() {
  const [pincode, setPincode] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const check = async (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(pincode)) return setResult({ ok: false, text: 'Please enter a valid 6-digit pincode' });
    setBusy(true);
    try {
      const place = await api.pincode(pincode);
      if (place.found === false) setResult({ ok: false, text: 'We couldn’t find this pincode. Please check it.' });
      else if (place.deliverable === false) setResult({ ok: false, text: `Sorry, we don’t deliver to ${place.city} yet.` });
      else setResult({ ok: true, text: `${place.city ? `${place.city}: delivery` : 'Delivery'} by ${deliveryDate(place.days.max)}` });
    } catch (err) {
      setResult({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="delivery-check" onSubmit={check}>
      <Icon name="mapPin" size={16} />
      <input value={pincode} onChange={(e) => setPincode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="Enter delivery pincode" inputMode="numeric" autoComplete="postal-code" aria-label="Delivery pincode" />
      <button type="submit" className="btn-link" disabled={busy}>{busy ? 'Checking…' : 'Check'}</button>
      {result && <p className={result.ok ? 'text-success' : 'text-error'} role="status">{result.text}</p>}
    </form>
  );
}

export default function ProductDetail() {
  const { id } = useParams();
  const [product, setProduct] = useState(null);
  const [error, setError] = useState('');
  const [activeImage, setActiveImage] = useState(0);
  const [fullView, setFullView] = useState(false);
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
        if (p.images360?.length >= 4) setActiveImage(SPIN_VIEW);
        addRecentlyViewed(p);
        trackViewItem(p);
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

  useSeo(product ? {
    title: productTitle(product, PREVIEW),
    description: productDescription(product, PREVIEW),
    path: productPath(product),
    image: product.image,
    type: 'product',
    jsonLd: [productLd(product), breadcrumbLd([{ name: 'Home', path: '/' }, { name: categoryLabel(product.category), path: `/products?category=${product.category}` }, { name: product.name, path: productPath(product) }])],
  } : { title: 'Product', noindex: true });

  if (error) return <div className="container"><EmptyState title="Product not found" message={error} action={{ to: '/products', label: 'Continue shopping' }} /></div>;
  if (!product) return <Spinner />;

  const images = product.images?.length ? product.images : [product.image];
  const frames360 = product.images360?.length >= 4 ? product.images360 : null;
  const show360 = frames360 && activeImage === SPIN_VIEW;
  const outOfStock = product.stock === 0;
  const wished = inWishlist(product._id);
  const rating = shownRating(product);

  return (
    <div className="page-detail container">
      <div className={`detail panel ${STORE ? 'detail-store' : ''}`}>
        <div className={`detail-gallery ${product.category === 'fashion' ? 'detail-gallery-portrait' : ''}`}>
          <div className="thumbs">
            {frames360 && (
              <button type="button" className={`thumb-360 ${show360 ? 'active' : ''}`} onClick={() => setActiveImage(SPIN_VIEW)} aria-label="360° view">
                <Icon name="rotate" size={18} />
                <span>360°</span>
              </button>
            )}
            {images.map((src, i) => (
              <button key={src} type="button" className={i === activeImage ? 'active' : ''} onMouseEnter={() => setActiveImage(i)} onClick={() => setActiveImage(i)} aria-label={`Image ${i + 1}`}>
                <img {...responsiveImage(src, '64px')} alt="" />
              </button>
            ))}
          </div>
          <div className="main-image">
            {show360 ? <Spin360 frames={frames360} alt={product.name} /> : <ZoomImage src={images[activeImage]} alt={product.name} onOpen={() => setFullView(true)} />}
            {!show360 && images.length > 1 && (
              <>
                <button type="button" className="gallery-step prev" onClick={() => setActiveImage((activeImage - 1 + images.length) % images.length)} aria-label="Previous photo"><Icon name="chevronLeft" size={20} /></button>
                <button type="button" className="gallery-step next" onClick={() => setActiveImage((activeImage + 1) % images.length)} aria-label="Next photo"><Icon name="chevronRight" size={20} /></button>
                <span className="gallery-count">{activeImage + 1} / {images.length}</span>
              </>
            )}
            {frames360 && !show360 && (
              <button type="button" className="view-360-btn" onClick={() => setActiveImage(SPIN_VIEW)}>
                <Icon name="rotate" size={14} /> View in 360°
              </button>
            )}
            {SHOPPING && (
            <button type="button" className={`wish-btn large ${wished ? 'active' : ''}`} onClick={() => toggleWishlist(product)} aria-label={wished ? 'Remove from wishlist' : 'Add to wishlist'}>
              <Icon name="heart" size={20} filled={wished} />
            </button>
            )}
          </div>
          {!show360 && <p className="gallery-hint">Click the photo to see full view{images.length > 1 ? ` · ${images.length} photos` : ''}</p>}
          {fullView && <Lightbox images={images} start={activeImage} alt={product.name} onClose={() => setFullView(false)} />}
          {!STORE && <div className="detail-actions">
            {!SHOPPING ? (
              <button type="button" className="btn btn-cart btn-lg coming-soon" disabled>Coming soon</button>
            ) : (
              <>
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
              </>
            )}
          </div>}
          {product.imageCredit && (
            <p className="image-credit">
              Photo: {product.imageCredit.author} ·{' '}
              <a href={product.imageCredit.source} target="_blank" rel="noreferrer">{product.imageCredit.license}, via Wikimedia Commons</a>
            </p>
          )}
        </div>

        <div className="detail-info">
          <nav className="breadcrumbs" aria-label="Breadcrumb">
            <Link to="/">Home</Link> <Icon name="chevronRight" size={12} />
            {groupOf(product.category) && <><Link to={`/products?use=${groupOf(product.category).id}`}>{groupOf(product.category).label}</Link> <Icon name="chevronRight" size={12} /></>}
            {product.category === 'grocery' ? (
              <><Link to="/grocery">Grocery</Link> <Icon name="chevronRight" size={12} /> <Link to={`/grocery?aisle=${product.subCategory}`}>{aisleLabel(product.subCategory)}</Link></>
            ) : (
              <><Link to={`/products?category=${product.category}`}>{categoryLabel(product.category)}</Link> <Icon name="chevronRight" size={12} /> <span>{product.brand}</span></>
            )}
          </nav>
          {product.brand && <p className="detail-brand">{product.brand}</p>}
          <div className="detail-title">
            <h1>{product.name}</h1>
            <ShareButton product={product} />
          </div>
          {product.unit && <p className="detail-unit">Pack size: <strong>{product.unit}</strong></p>}
          <div className="detail-rating">
            {rating.count > 0 ? (
              <>
                <Rating value={rating.value} />
                <span className="muted">{rating.count.toLocaleString('en-IN')} ratings</span>
              </>
            ) : <span className="muted">No ratings yet</span>}
            {!PREVIEW && product.featured && <span className="assured"><Icon name="shield" size={12} /> Arvixa Assured</span>}
          </div>
          {!PREVIEW && product.discount > 0 && <p className="text-success special">Special price</p>}
          <Price price={product.price} mrp={product.mrp} size="lg" />
          {STORE && <StoreFacts />}
          {!PREVIEW && (
            <>
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
            </>
          )}

          {(product.videos?.length > 0 || product.audio) && (
            <div className="detail-section">
              <h3>Videos &amp; audio</h3>
              <div className="product-media">
                {product.videos?.map((src, i) => (
                  <video key={src} src={src} controls preload="metadata" playsInline aria-label={`${product.name} video ${i + 1}`} />
                ))}
              </div>
              {product.audio && (
                <div className="product-audio">
                  <span><Icon name="music" size={16} /> Listen</span>
                  <audio src={product.audio} controls preload="none" aria-label={`${product.name} audio`} />
                </div>
              )}
            </div>
          )}

          <div className="detail-section">
            <h3>Product description</h3>
            <p className="description">{product.description}</p>
            <table className="spec-table">
              <tbody>
                <tr><th>Product ID</th><td className="id-line">{product._id}</td></tr>
                <tr><th>Brand</th><td>{product.brand || '—'}</td></tr>
                <tr><th>Category</th><td>{categoryLabel(product.category)}</td></tr>
                {product.tags?.length > 0 && <tr><th>Tags</th><td>{product.tags.join(', ')}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        {STORE && <BuyBox product={product} />}
      </div>

      {!PREVIEW && <Reviews productId={product._id} />}

      <ProductRail
        title={PREVIEW ? 'You may also like' : together.strategy === 'bought_together' ? 'Frequently bought together' : 'Customers also viewed'}
        subtitle={PREVIEW ? undefined : 'Based on what other shoppers bought and browsed'}
        products={together.items}
      />
      <ProductRail title="Similar products" subtitle="You may also like" products={similar} viewAll={`/products?category=${product.category}`} />
    </div>
  );
}
