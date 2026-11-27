import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { SUPPORT_WHATSAPP_LABEL, whatsappLink } from '../../config';
import Icon from '../common/Icon';

// The store's promises, one at a time on small screens (all of them stay true: see the shipping and returns pages)
const MESSAGES = [
  { icon: 'truck', text: 'Free delivery on orders above ₹499', to: '/shipping' },
  { icon: 'returns', text: 'Easy 7-day returns', to: '/refunds' },
  { icon: 'wallet', text: 'Cash on delivery available', to: '/help' },
];

// The colourful strip above the header: store promises on the left, WhatsApp support on the right
export default function AnnouncementBar() {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    const t = setInterval(() => setI((n) => (n + 1) % MESSAGES.length), 4000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="announce" role="region" aria-label="Store offers">
      <div className="announce-inner container">
        <ul className="announce-list">
          {MESSAGES.map((m, n) => (
            <li key={m.text} className={n === i ? 'current' : ''}>
              <Link to={m.to}><Icon name={m.icon} size={14} /> {m.text}</Link>
            </li>
          ))}
        </ul>
        <a className="announce-support" href={whatsappLink('Hi Arvixa, I need help with ')} target="_blank" rel="noopener noreferrer">
          <Icon name="message" size={14} /> WhatsApp {SUPPORT_WHATSAPP_LABEL}
        </a>
      </div>
    </div>
  );
}
