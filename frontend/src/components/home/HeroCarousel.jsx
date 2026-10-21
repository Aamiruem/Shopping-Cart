import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { HERO_SLIDES } from '../../constants/catalog';
import Icon from '../common/Icon';

const INTERVAL_MS = 5000;

export default function HeroCarousel({ slides = HERO_SLIDES }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  const go = useCallback((i) => setIndex((i + slides.length) % slides.length), [slides.length]);

  useEffect(() => {
    if (paused) return undefined;
    const timer = setInterval(() => setIndex((i) => (i + 1) % slides.length), INTERVAL_MS);
    return () => clearInterval(timer);
  }, [paused, slides.length]);

  return (
    <section
      className="hero"
      aria-roledescription="carousel"
      aria-label="Featured offers"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="hero-track" style={{ transform: `translateX(-${index * 100}%)` }}>
        {slides.map((s, i) => (
          <Link
            key={s.id}
            to={s.to}
            className={`hero-slide theme-${s.theme}`}
            aria-hidden={i !== index}
            tabIndex={i === index ? 0 : -1}
          >
            <div className="hero-copy">
              <span className="hero-eyebrow">{s.eyebrow}</span>
              <h2>{s.title}</h2>
              <p>{s.subtitle}</p>
              <span className="btn btn-light">Shop now <Icon name="arrowRight" size={16} /></span>
            </div>
            <img src={s.image} alt="" className="hero-img" loading={i === 0 ? 'eager' : 'lazy'} />
          </Link>
        ))}
      </div>

      <button type="button" className="hero-arrow left" onClick={() => go(index - 1)} aria-label="Previous slide"><Icon name="chevronLeft" size={28} /></button>
      <button type="button" className="hero-arrow right" onClick={() => go(index + 1)} aria-label="Next slide"><Icon name="chevronRight" size={28} /></button>

      <div className="hero-dots">
        {slides.map((s, i) => (
          <button key={s.id} type="button" className={i === index ? 'active' : ''} onClick={() => go(i)} aria-label={`Go to slide ${i + 1}`} />
        ))}
      </div>
    </section>
  );
}
