import { useEffect, useRef, useState } from 'react';
import { SITE_URL } from '../../config';
import { useToast } from '../../context/ToastContext';
import { productPath } from '../../hooks/useSeo';
import { formatPrice } from '../../utils/format';
import Icon from '../common/Icon';

// Builds a File from the photo on screen, for share sheets that accept images (phones). null if the image host
// doesn't allow it or the browser can't share files.
async function photoFile(src, name) {
  if (!src || !navigator.canShare) return null;
  try {
    const res = await fetch(src, { mode: 'cors' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) return null;
    const ext = blob.type.split('/')[1].replace('jpeg', 'jpg');
    const file = new File([blob], `${name.replace(/[^\w-]+/g, '-').slice(0, 60)}.${ext}`, { type: blob.type });
    return navigator.canShare({ files: [file] }) ? file : null;
  } catch {
    return null;
  }
}

// Share a product: the photo being viewed with its name, price and link through the phone's share sheet, or a
// WhatsApp / Facebook / X / Telegram / email / copy-link menu. The link is the product's own page, whose preview
// (WhatsApp, Facebook...) shows this product's photo, name and price.
export default function ShareButton({ product, image, floating = false }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  const url = `${SITE_URL}${productPath(product)}`;
  const message = `${product.name} for ${formatPrice(product.price)} on Arvixa Store`;

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => !box.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const nativeShare = async () => {
    setBusy(true);
    try {
      const file = await photoFile(image || product.image, product.name);
      // With a photo, many apps drop `url`, so the link also goes in the text
      await navigator.share(file ? { files: [file], title: product.name, text: `${message}\n${url}` } : { title: product.name, text: message, url });
      setOpen(false);
    } catch { /* the shopper closed the share sheet */ } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.show('Link copied');
    } catch {
      toast.show('Couldn’t copy the link. Copy it from the address bar.', 'error');
    }
    setOpen(false);
  };

  const encoded = { url: encodeURIComponent(url), text: encodeURIComponent(message), both: encodeURIComponent(`${message}\n${url}`) };
  const targets = [
    ['WhatsApp', `https://wa.me/?text=${encoded.both}`, 'message'],
    ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${encoded.url}`, 'users'],
    ['X', `https://twitter.com/intent/tweet?text=${encoded.text}&url=${encoded.url}`, 'send'],
    ['Telegram', `https://t.me/share/url?url=${encoded.url}&text=${encoded.text}`, 'send'],
    ['Email', `mailto:?subject=${encodeURIComponent(product.name)}&body=${encoded.both}`, 'mail'],
  ];

  return (
    <div className={`share-wrap ${floating ? 'floating' : ''}`} ref={box}>
      <button type="button" className="share-btn" onClick={() => setOpen(!open)} aria-label={`Share ${product.name}`} aria-expanded={open} title="Share">
        <Icon name="send" size={floating ? 17 : 18} />
      </button>
      {open && (
        <div className="share-menu panel" role="menu" aria-label="Share this product">
          <div className="share-preview">
            <img src={image || product.image} alt="" />
            <span><strong>{product.name}</strong><span className="muted small block">{formatPrice(product.price)}</span></span>
          </div>
          {typeof navigator !== 'undefined' && navigator.share && (
            <button type="button" role="menuitem" className="share-item primary" onClick={nativeShare} disabled={busy}>
              <Icon name="image" size={16} /> {busy ? 'Preparing photo…' : 'Share photo & link'}
            </button>
          )}
          {targets.map(([label, href, icon]) => (
            <a key={label} role="menuitem" className="share-item" href={href} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>
              <Icon name={icon} size={16} /> {label}
            </a>
          ))}
          <button type="button" role="menuitem" className="share-item" onClick={copy}><Icon name="copy" size={16} /> Copy link</button>
        </div>
      )}
    </div>
  );
}
