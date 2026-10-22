import { useState } from 'react';
import { Link } from 'react-router-dom';
import { productPath } from '../../hooks/useSeo';
import { formatPrice } from '../../utils/format';
import Icon from '../common/Icon';

const KINDS = [
  { id: '', label: 'All tips' },
  { id: 'stock', label: 'Stock', icon: 'package' },
  { id: 'price', label: 'Pricing', icon: 'tag' },
  { id: 'listing', label: 'Listing quality', icon: 'image' },
  { id: 'visibility', label: 'Visibility', icon: 'search' },
  { id: 'checkout', label: 'Cart drop-off', icon: 'cart' },
  { id: 'trend', label: 'Trending', icon: 'zap' },
];
const pct = (v) => `${(v * 100).toFixed(1)}%`;

function ScoreBar({ score }) {
  const tone = score >= 75 ? 'good' : score >= 50 ? 'ok' : 'low';
  return (
    <span className={`score-bar ${tone}`} title={`Listing quality ${score}/100`}>
      <span className="track"><i style={{ width: `${score}%` }} /></span> <b>{score}</b>
    </span>
  );
}

// Growth advisor: which products need attention and exactly what to change, ranked by the money it could unlock
export default function GrowthTab({ data }) {
  const [kind, setKind] = useState('');
  const { summary, products } = data;
  const rows = products.filter((p) => p.tips.length && (!kind || p.tips.some((t) => t.kind === kind))).slice(0, 40);

  return (
    <div className="growth">
      <div className="growth-stats">
        <div className="g-stat"><span>Revenue · 30 days</span><strong>{formatPrice(summary.revenue30)}</strong></div>
        <div className="g-stat"><span>Store conversion</span><strong>{pct(summary.conversion)}</strong><small>Marketplace: {pct(summary.marketConversion)}</small></div>
        <div className="g-stat"><span>Avg. listing quality</span><strong>{summary.avgListingScore}/100</strong></div>
        <div className="g-stat"><span>Out of stock</span><strong>{summary.outOfStock}</strong><small>of {summary.products} products</small></div>
        <div className="g-stat highlight"><span>Potential extra sales</span><strong>{formatPrice(summary.opportunity)}</strong><small>if the top 20 tips are applied (estimate)</small></div>
      </div>

      <div className="type-chips growth-filter">
        {KINDS.map((k) => (
          <button key={k.id} type="button" className={kind === k.id ? 'active' : ''} onClick={() => setKind(k.id)}>
            {k.icon && <Icon name={k.icon} size={13} />} {k.label}
          </button>
        ))}
      </div>

      <ol className="growth-list">
        {rows.map((p) => (
          <li key={p.productId} className="growth-card">
            <img src={p.image} alt="" />
            <div className="growth-main">
              <div className="growth-title">
                <Link to={productPath({ _id: p.productId, name: p.name })} target="_blank">{p.name}</Link>
                <ScoreBar score={p.listingScore} />
              </div>
              <div className="growth-metrics">
                <span title="Views → add to cart → purchases, last 30 days"><Icon name="eye" size={12} /> {p.views} → <Icon name="cart" size={12} /> {p.addToCarts} → <Icon name="checkCircle" size={12} /> {p.purchases}</span>
                <span>Conversion {pct(p.conversion)}</span>
                <span className={p.priceGap > 0.15 ? 'warn' : p.priceGap < -0.1 ? 'good' : ''}>
                  {formatPrice(p.price)} vs similar {formatPrice(p.peerPrice)}
                </span>
                {p.demandChange !== 0 && <span className={p.demandChange > 0 ? 'good' : 'warn'}>Demand {p.demandChange > 0 ? '+' : ''}{Math.round(p.demandChange * 100)}%</span>}
                <span>{p.stock === 0 ? 'Out of stock' : p.daysOfStock ? `~${Math.round(p.daysOfStock)} days of stock` : `${p.stock} in stock`}</span>
              </div>
              <ul className="growth-tips">
                {p.tips.filter((t) => !kind || t.kind === kind).map((t) => (
                  <li key={t.text} className={`tip-${t.kind}`}>
                    <Icon name={KINDS.find((k) => k.id === t.kind)?.icon || 'zap'} size={14} />
                    <span>{t.text}</span>
                    {t.value > 0 && <em>up to {formatPrice(t.value)}</em>}
                  </li>
                ))}
              </ul>
            </div>
            <Link to="/seller/products" className="btn btn-outline btn-sm">Fix it</Link>
          </li>
        ))}
      </ol>
      {!rows.length && <p className="muted" style={{ padding: 16 }}>Nothing to fix here. Nice work!</p>}
      <p className="muted small growth-note">Estimates use your last 30 days of views, carts and orders compared with similar products across Arvixa. They show where to look first, not guaranteed earnings.</p>
    </div>
  );
}
