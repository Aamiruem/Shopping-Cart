import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { formatDate, formatPrice } from '../../utils/format';
import { responsiveImage } from '../../utils/image';
import Icon from '../common/Icon';
import ProductRail from '../product/ProductRail';

// Drawn here rather than a photo, so it stays sharp at any size and weighs a few hundred bytes
function Diya({ x, y, scale = 1 }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <ellipse cx="0" cy="-30" rx="15" ry="26" fill="url(#festive-glow)" />
      <path d="M0 -44 C 7 -32 8 -22 0 -14 C -8 -22 -7 -32 0 -44 Z" fill="#ffd34d" />
      <path d="M0 -36 C 3 -29 3 -23 0 -18 C -3 -23 -3 -29 0 -36 Z" fill="#fff7d6" />
      <path d="M-34 -10 Q 0 -4 34 -10 Q 30 14 0 16 Q -30 14 -34 -10 Z" fill="#e8742a" />
      <path d="M-34 -10 Q 0 -4 34 -10 Q 0 -16 -34 -10 Z" fill="#ffb347" />
      <path d="M-24 2 Q 0 8 24 2" stroke="#ffd34d" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <circle cx="-12" cy="6" r="2" fill="#ffd34d" />
      <circle cx="12" cy="6" r="2" fill="#ffd34d" />
    </g>
  );
}

function Rangoli({ x, y, r }) {
  const petals = Array.from({ length: 12 }, (_, i) => i * 30);
  return (
    <g transform={`translate(${x} ${y})`} opacity="0.9">
      {petals.map((a) => <ellipse key={a} cx="0" cy={-r * 0.62} rx={r * 0.16} ry={r * 0.36} transform={`rotate(${a})`} fill={a % 60 ? '#ff9f1c' : '#ff3d77'} />)}
      {petals.map((a) => <ellipse key={`i${a}`} cx="0" cy={-r * 0.32} rx={r * 0.1} ry={r * 0.2} transform={`rotate(${a + 15})`} fill="#ffd34d" />)}
      <circle r={r * 0.17} fill="#2ec4b6" />
      <circle r={r * 0.08} fill="#fff7d6" />
    </g>
  );
}

function FestiveArt({ theme }) {
  const lights = Array.from({ length: 13 }, (_, i) => ({ x: 20 + i * 30, y: 18 + Math.sin(i / 1.6) * 7 }));
  return (
    <svg className="festive-art" viewBox="0 0 400 240" role="img" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="festive-glow">
          <stop offset="0" stopColor="#fff3b0" stopOpacity="0.95" />
          <stop offset="1" stopColor="#ffb347" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d={`M0 12 ${lights.map((l) => `L${l.x} ${l.y}`).join(' ')} L400 12`} stroke="rgba(255,255,255,0.35)" strokeWidth="1.5" fill="none" />
      {lights.map((l, i) => (
        <g key={i}>
          <circle cx={l.x} cy={l.y + 7} r="9" fill="url(#festive-glow)" />
          <circle cx={l.x} cy={l.y + 7} r="3.6" fill={['#ffd34d', '#ff6b9a', '#7ee8fa'][i % 3]} />
        </g>
      ))}
      {theme === 'diwali' ? (
        <>
          <Rangoli x={292} y={168} r={70} />
          <Diya x={150} y={196} scale={1.25} />
          <Diya x={246} y={214} scale={0.9} />
          <Diya x={360} y={212} scale={0.8} />
        </>
      ) : (
        <>
          <Rangoli x={292} y={160} r={62} />
          {[[120, 120], [200, 80], [350, 70], [170, 190], [380, 180]].map(([x, y]) => (
            <path key={`${x}${y}`} d={`M${x} ${y - 12} L${x + 3} ${y - 3} L${x + 12} ${y} L${x + 3} ${y + 3} L${x} ${y + 12} L${x - 3} ${y + 3} L${x - 12} ${y} L${x - 3} ${y - 3} Z`} fill="#fff7d6" opacity="0.85" />
          ))}
        </>
      )}
    </svg>
  );
}

// Top of the home page: the festival (or season) store, collections and what's trending, from /api/recommendations/festive
export default function FestiveStore() {
  const [store, setStore] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.festive()
      .then((s) => !cancelled && setStore(s))
      .catch(() => !cancelled && setStore(false)); // the rest of the home page still works without it
    return () => {
      cancelled = true;
    };
  }, []);

  if (store === false) return null;
  if (!store) return <div className="festive festive-loading" aria-busy="true" aria-label="Loading the festive store" />;

  const { season, collections, trending, signal } = store;
  return (
    <>
      <section className={`festive theme-${season.theme}`} aria-labelledby="festive-title">
        <div className="festive-banner">
          <div className="festive-copy">
            <p className="festive-eyebrow"><Icon name="gift" size={14} /> {season.kind === 'festival' ? `${season.name} store` : 'Shop the season'}</p>
            <h2 id="festive-title">{season.greeting}</h2>
            <p className="festive-tagline">{season.tagline}</p>
            {season.endsOn && <p className="festive-ends">Festive store open until {formatDate(season.endsOn, { day: 'numeric', month: 'long' })}</p>}
            {collections[0] && <Link to={collections[0].to} className="festive-shop">Explore the store <Icon name="chevronRight" size={16} /></Link>}
          </div>
          <FestiveArt theme={season.theme} />
        </div>

        <div className="festive-tiles">
          {collections.map((c) => (
            <Link key={c.id} to={c.to} className="festive-tile">
              <span className="festive-tile-price">{c.under ? `Under ${formatPrice(c.under)}` : `${c.count} picks`}</span>
              <span className="festive-tile-title">{c.title}</span>
              <span className="festive-collage">
                {c.images.map((img) => <img key={img.src} {...responsiveImage(img.src, '(max-width: 600px) 30vw, 120px')} alt="" loading="lazy" decoding="async" />)}
              </span>
              <span className="festive-tile-cta">Shop now <Icon name="chevronRight" size={14} /></span>
            </Link>
          ))}
        </div>
      </section>

      <ProductRail
        tone="highlight"
        title={`Trending this ${season.kind === 'festival' ? season.name : season.name.toLowerCase()}`}
        subtitle={signal === 'demand' ? 'Ranked by what shoppers are ordering, adding to cart and saving right now' : 'Popular picks for the season'}
        products={trending}
        viewAll={collections[0]?.to}
      />
    </>
  );
}
