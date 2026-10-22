import { useEffect, useRef, useState } from 'react';
import Icon from '../common/Icon';

const PX_PER_FRAME = 60;   // drag distance that turns the product by one frame
const AUTO_SPIN_MS = 900;  // auto-rotate speed until the shopper takes over

// 360° product viewer: `frames` are photos of a turntable in rotation order.
// Drag / swipe or use the arrow keys to turn it; adjacent frames cross-fade so even a
// 4-frame set rotates smoothly.
export default function Spin360({ frames, alt }) {
  const count = frames.length;
  const [position, setPosition] = useState(0); // fractional frame index, 0..count
  const [playing, setPlaying] = useState(() => !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const [touched, setTouched] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef(null);

  const wrap = (value) => ((value % count) + count) % count;
  const takeOver = () => {
    setPlaying(false);
    setTouched(true);
  };

  useEffect(() => {
    if (!playing) return undefined;
    const t = setInterval(() => setPosition((p) => wrap(Math.round(p) + 1)), AUTO_SPIN_MS);
    return () => clearInterval(t);
  }, [playing, count]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (e) => {
    takeOver();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, start: position };
    setDragging(true);
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    // Dragging right turns the product to show its left side, like spinning it by hand
    setPosition(wrap(drag.current.start - (e.clientX - drag.current.x) / PX_PER_FRAME));
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
    setPosition((p) => wrap(Math.round(p)));
  };
  const step = (delta) => {
    takeOver();
    setPosition((p) => wrap(Math.round(p) + delta));
  };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else return;
    e.preventDefault();
  };

  const base = Math.floor(position) % count;
  const next = (base + 1) % count;
  const blend = position - Math.floor(position);
  const degrees = Math.round((position / count) * 360) % 360;

  return (
    <div className="spin360">
      <div
        className={`spin360-stage ${dragging ? 'dragging' : ''}`}
        role="slider"
        tabIndex={0}
        aria-label={`360° view of ${alt}. Drag or use the arrow keys to rotate.`}
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={degrees}
        aria-valuetext={`${degrees} degrees`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        {/* Every frame stays mounted so the images are preloaded and switching never flashes */}
        {frames.map((src, i) => (
          <img
            key={src}
            src={src}
            alt=""
            draggable={false}
            style={{ opacity: i === base ? 1 - blend : i === next ? blend : 0 }}
          />
        ))}
      </div>

      <span className="spin360-badge"><Icon name="rotate" size={12} /> 360°</span>
      {!touched && <span className="spin360-hint">Drag to rotate</span>}

      <div className="spin360-controls">
        <button type="button" onClick={() => step(-1)} aria-label="Rotate left"><Icon name="chevronLeft" size={16} /></button>
        <button type="button" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Stop rotating' : 'Rotate automatically'}>
          <Icon name={playing ? 'pause' : 'play'} size={14} />
        </button>
        <button type="button" onClick={() => step(1)} aria-label="Rotate right"><Icon name="chevronRight" size={16} /></button>
        <span className="spin360-dots" aria-hidden="true">
          {frames.map((src, i) => <i key={src} className={i === Math.round(position) % count ? 'on' : ''} />)}
        </span>
      </div>
    </div>
  );
}
