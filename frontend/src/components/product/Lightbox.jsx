import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../common/Icon';

// Full-screen photo viewer: arrows, arrow keys, swipe on phones, thumbnails, Esc or a click outside to close
export default function Lightbox({ images, start = 0, alt, onClose }) {
  const [index, setIndex] = useState(start);
  const touchX = useRef(null);
  const closeButton = useRef(null);
  const count = images.length;
  const go = useCallback((step) => setIndex((i) => (i + step + count) % count), [count]);

  useEffect(() => {
    const opener = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
    };
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, [go, onClose]);

  const onTouchEnd = (e) => {
    const dx = e.changedTouches[0].clientX - (touchX.current ?? e.changedTouches[0].clientX);
    if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
    touchX.current = null;
  };

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`${alt}: photo ${index + 1} of ${count}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <button ref={closeButton} type="button" className="lightbox-close" onClick={onClose} aria-label="Close"><Icon name="x" size={26} /></button>
      <div className="lightbox-stage" onTouchStart={(e) => { touchX.current = e.touches[0].clientX; }} onTouchEnd={onTouchEnd}>
        {count > 1 && <button type="button" className="lightbox-nav prev" onClick={() => go(-1)} aria-label="Previous photo"><Icon name="chevronLeft" size={28} /></button>}
        <img key={images[index]} src={images[index]} alt={`${alt}, photo ${index + 1}`} />
        {count > 1 && <button type="button" className="lightbox-nav next" onClick={() => go(1)} aria-label="Next photo"><Icon name="chevronRight" size={28} /></button>}
      </div>
      {count > 1 && (
        <div className="lightbox-strip">
          <span className="lightbox-count" aria-live="polite">{index + 1} / {count}</span>
          {images.map((src, i) => (
            <button key={src} type="button" className={i === index ? 'active' : ''} onClick={() => setIndex(i)} aria-label={`Photo ${i + 1}`} aria-current={i === index}>
              <img src={src} alt="" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
