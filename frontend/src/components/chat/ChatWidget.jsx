import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useAuthModal } from '../../context/AuthModalContext';
import { useCart } from '../../context/CartContext';
import { responsiveImage } from '../../utils/image';
import { playSound } from '../../utils/sound';
import Icon from '../common/Icon';
import Price from '../common/Price';

const GREETING = {
  role: 'assistant',
  content: 'Hi! Tell me what you’re looking for, what it’s for and your budget — like “running shoes under ₹3,000”. I can also answer questions about delivery, payment and returns.',
};
const EXAMPLES = ['Phone under ₹20,000', 'Running shoes under ₹3,000', 'What is your return policy?'];

// One product the assistant suggested. The shopper decides: open it, or add it to the cart with the button.
function ProductSuggestion({ product, onAdded }) {
  const { user } = useAuth();
  const { openLogin } = useAuthModal();
  const { add } = useCart();
  const [state, setState] = useState('idle'); // idle | adding | added | error
  const addToCart = async () => {
    if (!user) return openLogin();
    setState('adding');
    try {
      await add(product.id, 1);
      setState('added');
      playSound('success');
      onAdded?.(product);
    } catch {
      setState('error');
    }
  };
  return (
    <div className="chat-product">
      <Link to={product.url} className="chat-product-link">
        {product.image && <img {...responsiveImage(product.image, '56px')} alt="" width="56" height="56" loading="lazy" />}
        <span>
          <strong>{product.name}</strong>
          <Price price={product.price} mrp={product.mrp} size="sm" />
          {product.stock > 0 && product.stock <= 5 && <span className="muted small">Only {product.stock} left</span>}
        </span>
      </Link>
      <button type="button" className="btn btn-outline btn-sm" disabled={state === 'adding' || state === 'added'} onClick={addToCart}>
        {state === 'added' ? <><Icon name="check" size={14} /> Added</> : state === 'adding' ? 'Adding…' : state === 'error' ? 'Try again' : 'Add to cart'}
      </button>
    </div>
  );
}

// Other parts of the page (e.g. the More menu) open the chat with: window.dispatchEvent(new Event(OPEN_CHAT_EVENT))
export const OPEN_CHAT_EVENT = 'chat:open';

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([GREETING]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef(null);

  useEffect(() => {
    const openChat = () => setOpen(true);
    window.addEventListener(OPEN_CHAT_EVENT, openChat);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, openChat);
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const ask = async (text) => {
    if (!text || busy) return;
    const history = [...messages, { role: 'user', content: text }];
    setMessages(history);
    setInput('');
    setBusy(true);
    try {
      // Only the conversation itself: not the greeting, not the product cards
      const conversation = history.slice(1).map(({ role, content }) => ({ role, content }));
      // The full API's agent needs a login; when it can't answer, its knowledge-base Q&A does
      const result = await api.agent(conversation).catch(() => api.ask(text));
      setMessages([...history, { role: 'assistant', content: result.reply ?? result.answer, products: result.products || [] }]);
      playSound('click');
    } catch (err) {
      setMessages([...history, { role: 'assistant', content: `Sorry — ${err.message}`, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const send = (e) => {
    e.preventDefault();
    ask(input.trim());
  };

  if (!open) {
    return (
      <button type="button" className="chat-fab" onClick={() => setOpen(true)} aria-label="Open shopping assistant">
        <Icon name="message" size={22} />
        <span>Help</span>
      </button>
    );
  }

  return (
    <div className="chat-panel" role="dialog" aria-label="Shopping assistant">
      <header className="chat-head">
        <div>
          <strong>Arvixa Assistant</strong>
          <span>Finds products in stock · answers order questions</span>
        </div>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close chat"><Icon name="x" size={18} /></button>
      </header>
      <div className="chat-body" ref={bodyRef} aria-live="polite">
        {messages.map((m, i) => (
          <div key={i} className={`chat-turn ${m.role}`}>
            <p className={`bubble ${m.role} ${m.error ? 'error' : ''}`}>{m.content}</p>
            {m.products?.length > 0 && (
              <div className="chat-products">
                {m.products.map((p) => <ProductSuggestion key={p.id} product={p} />)}
              </div>
            )}
          </div>
        ))}
        {messages.length === 1 && (
          <div className="chat-examples">
            {EXAMPLES.map((q) => <button key={q} type="button" className="chip" onClick={() => ask(q)}>{q}</button>)}
          </div>
        )}
        {busy && <p className="bubble assistant typing"><span /><span /><span /></p>}
      </div>
      <form className="chat-input" onSubmit={send}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="What are you looking for?" aria-label="Message" maxLength={2000} />
        <button type="submit" disabled={busy || !input.trim()} aria-label="Send"><Icon name="send" size={18} /></button>
      </form>
      <p className="chat-note">Answers come from our live catalog. Products are only added to your cart when you press the button.</p>
    </div>
  );
}
