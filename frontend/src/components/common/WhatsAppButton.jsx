import { useLocation } from 'react-router-dom';
import { SUPPORT_WHATSAPP_LABEL, whatsappLink } from '../../config';

// Staff pages have their own tools; the button is for shoppers
const HIDDEN = [/^\/crm/, /^\/seller/, /^\/admin/, /^\/checkout/];

// The message opens pre-filled with the page the customer is on, so support sees which product or order it's about
function message(pathname) {
  const page = typeof window !== 'undefined' ? window.location.href : '';
  if (pathname.startsWith('/products/')) return `Hi Arvixa, I have a question about this product: ${page}`;
  if (pathname.startsWith('/orders')) return `Hi Arvixa, I need help with my order: ${page}`;
  if (pathname.startsWith('/cart')) return 'Hi Arvixa, I need help with my cart before ordering.';
  return 'Hi Arvixa, I need help with ';
}

// Floating "chat on WhatsApp" button, stacked above the AI assistant's button
export default function WhatsAppButton() {
  const { pathname } = useLocation();
  if (HIDDEN.some((re) => re.test(pathname))) return null;
  return (
    <a className="wa-fab" href={whatsappLink(message(pathname))} target="_blank" rel="noopener noreferrer" aria-label={`Chat with Arvixa support on WhatsApp, ${SUPPORT_WHATSAPP_LABEL}`} title={`WhatsApp support · ${SUPPORT_WHATSAPP_LABEL}`}>
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.5 20.5l1.3-4.1A8.5 8.5 0 1 1 8 19.4z" />
        <path d="M9 8.6c0-.4.3-.8.7-.8h.6c.3 0 .5.2.6.4l.6 1.4c.1.3 0 .6-.2.8l-.5.5a6 6 0 0 0 2.6 2.6l.5-.5c.2-.2.5-.3.8-.2l1.4.6c.2.1.4.3.4.6v.6c0 .4-.4.7-.8.7A6.8 6.8 0 0 1 9 8.6z" fill="currentColor" stroke="none" />
      </svg>
      <span>WhatsApp</span>
    </a>
  );
}
