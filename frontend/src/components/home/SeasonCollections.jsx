import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { SEASONS } from '../../constants/catalog';
import Icon from '../common/Icon';

// Seasonal collections: each card searches the season tag; its picture is the top product of that season
export default function SeasonCollections() {
  const [covers, setCovers] = useState({});

  useEffect(() => {
    let cancelled = false;
    Promise.all(SEASONS.map((s) => api.products({ q: s.id, category: s.id === 'monsoon' ? '' : 'fashion', sort: 'popularity', limit: 1 }).catch(() => [])))
      .then((lists) => !cancelled && setCovers(Object.fromEntries(SEASONS.map((s, i) => [s.id, lists[i][0]?.image]))));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="panel season-section" aria-label="Shop by season">
      <header className="rail-head"><div><h2>Shop by season</h2><p className="muted small">Clothes, footwear and essentials for every weather and festival</p></div></header>
      <div className="season-grid">
        {SEASONS.map((s) => (
          <Link key={s.id} to={`/products?q=${s.id}`} className={`season-card theme-${s.theme}`}>
            <div>
              <strong>{s.label}</strong>
              <span>{s.note}</span>
              <span className="season-cta">Explore <Icon name="arrowRight" size={14} /></span>
            </div>
            {covers[s.id] && <img src={covers[s.id]} alt="" loading="lazy" />}
          </Link>
        ))}
      </div>
    </section>
  );
}
