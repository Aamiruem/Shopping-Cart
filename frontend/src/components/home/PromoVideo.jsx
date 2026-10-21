import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PROMO_VIDEO } from '../../constants/catalog';
import Icon from '../common/Icon';

// Autoplaying (muted) brand video with play/pause and sound controls
export default function PromoVideo() {
  const videoRef = useRef(null);
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(true);
  const [failed, setFailed] = useState(false);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  return (
    <section className="promo-video panel">
      <div className="promo-media">
        {failed ? (
          <img src={PROMO_VIDEO.poster} alt="" />
        ) : (
          <video
            ref={videoRef}
            src={PROMO_VIDEO.src}
            poster={PROMO_VIDEO.poster}
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={() => setFailed(true)}
          />
        )}
        {!failed && (
          <div className="video-controls">
            <button type="button" onClick={togglePlay} aria-label={playing ? 'Pause video' : 'Play video'}>
              <Icon name={playing ? 'pause' : 'play'} size={16} filled />
            </button>
            <button type="button" onClick={toggleMute} aria-label={muted ? 'Unmute video' : 'Mute video'}>
              <Icon name={muted ? 'volumeOff' : 'volume'} size={16} />
            </button>
          </div>
        )}
      </div>
      <div className="promo-copy">
        <span className="hero-eyebrow">The Home Edit</span>
        <h2>Bring a little nature home</h2>
        <p>Planters, decor and furniture picked to make every corner feel fresh. Up to 40% off this week only.</p>
        <Link to="/products?category=home" className="btn btn-buy">Explore Home <Icon name="arrowRight" size={16} /></Link>
      </div>
    </section>
  );
}
