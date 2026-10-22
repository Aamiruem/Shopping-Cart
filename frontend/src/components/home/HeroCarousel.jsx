import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { HERO_SLIDES } from '../../constants/catalog';
import Icon from '../common/Icon';

const INTERVAL_MS = 5000;
// Cards visible at once by viewport width (widest first)
const LAYOUTS = [['(min-width: 1100px)', 3], ['(min-width: 700px)', 2]];

function usePerView() {
  const pick = () => LAYOUTS.find(([q]) => window.matchMedia(q).matches)?.[1] ?? 1;
  const [perView, setPerView] = useState(pick);
  useEffect(() => {
    const lists = LAYOUTS.map(([q]) => window.matchMedia(q));
    const onChange = () => setPerView(pick());
    lists.forEach((m) => m.addEventListener('change', onChange));
    return () => lists.forEach((m) => m.removeEventListener('change', onChange));
  }, []);
  return perView;
}

// A row of offer cards (3 / 2 / 1 visible) that advances one card at a time
export default function HeroCarousel({ slides = HERO_SLIDES }) {
  const perView = usePerView();
  const pages = Math.max(1, slides.length - perView + 1);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  const go = useCallback((i) => setIndex((i + pages) % pages), [pages]);
  useEffect(() => setIndex((i) => Math.min(i, pages - 1)), [pages]);

  useEffect(() => {
    if (paused || pages < 2) return undefined;
    const timer = setInterval(() => setIndex((i) => (i + 1) % pages), INTERVAL_MS);
    return () => clearInterval(timer);
  }, [paused, pages]);

  return (
    <section
      className="hero"
      aria-roledescription="carousel"
      aria-label="Featured offers"
      style={{ '--per-view': perView }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="hero-viewport">
        <div className="hero-track" style={{ transform: `translateX(calc(-${index} * (100% + var(--hero-gap)) / var(--per-view)))` }}>
          {slides.map((s, i) => {
            const visible = i >= index && i < index + perView;
            return (
              <Link key={s.id} to={s.to} className={`hero-slide theme-${s.theme}`} aria-hidden={!visible} tabIndex={visible ? 0 : -1}>
                <div className="hero-copy">
                  <span className="hero-eyebrow">{s.eyebrow}</span>
                  <h2>{s.title}</h2>
                  <p>{s.subtitle}</p>
                  <span className="btn btn-light btn-sm">Shop now <Icon name="arrowRight" size={14} /></span>
                </div>
                <img src={s.image} alt="" className="hero-img" loading={i < 3 ? 'eager' : 'lazy'} />
              </Link>
            );
          })}
        </div>
      </div>

      {pages > 1 && (
        <>
          <button type="button" className="hero-arrow left" onClick={() => go(index - 1)} aria-label="Previous offers"><Icon name="chevronLeft" size={22} /></button>
          <button type="button" className="hero-arrow right" onClick={() => go(index + 1)} aria-label="Next offers"><Icon name="chevronRight" size={22} /></button>
          <div className="hero-dots">
            {Array.from({ length: pages }, (_, i) => (
              <button key={i} type="button" className={i === index ? 'active' : ''} onClick={() => go(i)} aria-label={`Show offers ${i + 1} of ${pages}`} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
