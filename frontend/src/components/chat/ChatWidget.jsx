import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { PREVIEW } from '../../config';
import { useAuth } from '../../context/AuthContext';
import { useCart } from '../../context/CartContext';
import useShopActions from '../../hooks/useShopActions';
import { formatPrice } from '../../utils/format';
import { responsiveImage } from '../../utils/image';
import { playSound } from '../../utils/sound';
import Icon from '../common/Icon';

const GREETING = {
  role: 'assistant',
  content: 'Hi! Tell me what you’re looking for and your budget, and I’ll find it in our catalog. I can also check your orders and explain delivery, payment and returns.',
  suggestions: ['Wireless earbuds under ₹3,000', 'Running shoes for men', "Women's ethnic wear under ₹2,000", 'Where is my order?'],
};

// Store mode (the Vercel API): one assistant that searches the live catalog, compares products, reads the shopper's
// orders and explains policies, with no login needed for searching (api/_assistant.mjs).
// Full API: "Ask" = RAG Q&A over products and policies, "Assistant" = agent that can search and add to the cart.
// Other parts of the page (e.g. the More menu) open the chat with: window.dispatchEvent(new Event(OPEN_CHAT_EVENT))
export const OPEN_CHAT_EVENT = 'chat:open';

function ProductCard({ product }) {
  const { addToCart } = useShopActions();
  const [adding, setAdding] = useState(false);
  const add = async () => {
    setAdding(true);
    await addToCart(product);
    setAdding(false);
  };
  const out = product.stock <= 0;
  return (
    <article className="chat-card">
      <Link to={`/products/${product._id}`} className="chat-card-link">
        <img {...responsiveImage(product.image, '96px')} alt="" loading="lazy" />
        <span className="chat-card-name">{product.name}</span>
      </Link>
      <div className="chat-card-price">
        <strong>{formatPrice(product.price)}</strong>
        {product.mrp > product.price && <s>{formatPrice(product.mrp)}</s>}
      </div>
      {!PREVIEW && product.rating > 0 && (
        <span className="chat-card-rating"><Icon name="star" size={11} /> {product.rating.toFixed(1)}</span>
      )}
      {product.stock > 0 && product.stock <= 5 && <span className="chat-card-low">Only {product.stock} left</span>}
      <button type="button" className="chat-card-add" onClick={add} disabled={adding || out} aria-label={`Add ${product.name} to cart`}>
        {out ? 'Out of stock' : <><Icon name="plus" size={14} /><Icon name="cart" size={15} /></>}
      </button>
    </article>
  );
}

function Message({ message, onSuggest, onNavigate }) {
  return (
    <div className={`chat-msg ${message.role}`}>
      <p className={`bubble ${message.role} ${message.error ? 'error' : ''}`}>{message.content}</p>
      {message.products?.length > 0 && (
        <div className="chat-cards">
          {message.products.map((p) => <ProductCard key={p._id} product={p} />)}
        </div>
      )}
      {message.links?.length > 0 && (
        <div className="chat-links">
          {message.links.map((l) => <Link key={l.to} to={l.to} onClick={onNavigate}>{l.label} <Icon name="arrowRight" size={12} /></Link>)}
        </div>
      )}
      {message.suggestions?.length > 0 && (
        <div className="chat-suggestions">
          {message.suggestions.map((s) => <button type="button" key={s} onClick={() => onSuggest(s)}>{s}</button>)}
        </div>
      )}
    </div>
  );
}

export default function ChatWidget() {
  const { user } = useAuth();
  const { refresh } = useCart();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(PREVIEW ? 'agent' : 'ask');
  const [messages, setMessages] = useState([GREETING]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const openChat = () => setOpen(true);
    window.addEventListener(OPEN_CHAT_EVENT, openChat);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, openChat);
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const switchMode = (next) => {
    setMode(next);
    setMessages([GREETING]);
  };

  const ask = async (text) => {
    if (!text || busy) return;
    const history = [...messages, { role: 'user', content: text }];
    setMessages(history);
    setInput('');
    setBusy(true);
    try {
      let result;
      if (mode === 'ask') {
        result = await api.ask(text);
      } else {
        // Skip the local greeting - the assistant only needs the real conversation
        result = await api.agent(history.slice(1).map(({ role, content }) => ({ role, content }))).catch((err) => {
          if (PREVIEW) throw err; // the store assistant has no fallback; show its own message (e.g. rate limit)
          return null;
        });
        if (result?.actions?.some((a) => a.tool === 'add_to_cart')) refresh();
        // Agent unavailable (e.g. no LLM key configured): answer from the store knowledge base instead
        if (!result) result = await api.ask(text);
      }
      setMessages([...history, {
        role: 'assistant',
        content: result.reply ?? result.answer,
        products: result.products || [],
        links: result.links || [],
        suggestions: result.suggestions || [],
      }]);
      playSound('click');
    } catch (err) {
      setMessages([...history, { role: 'assistant', content: `Sorry, ${err.message}`, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const send = (e) => {
    e.preventDefault();
    ask(input.trim());
  };

  const reset = () => setMessages([GREETING]);

  if (!open) {
    return (
      <button type="button" className="chat-fab" onClick={() => setOpen(true)} aria-label="Open shopping assistant">
        <Icon name="message" size={22} />
        <span>Ask AI</span>
      </button>
    );
  }

  return (
    <div className="chat-panel" role="dialog" aria-label="Shopping assistant">
      <header className="chat-head">
        <span className="chat-avatar" aria-hidden="true"><Icon name="zap" size={18} /></span>
        <div>
          <strong>Shopping Assistant</strong>
          <span>Real prices and stock from our catalog</span>
        </div>
        <button type="button" onClick={reset} aria-label="Start over" title="Start over"><Icon name="rotate" size={16} /></button>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close chat"><Icon name="x" size={18} /></button>
      </header>
      {!PREVIEW && (
        <div className="chat-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'ask'} className={mode === 'ask' ? 'active' : ''} onClick={() => switchMode('ask')}>
            Ask a question
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'agent'}
            className={mode === 'agent' ? 'active' : ''}
            disabled={!user}
            title={user ? '' : 'Log in to use the shopping assistant'}
            onClick={() => switchMode('agent')}
          >
            Shopping assistant {!user && <Icon name="lock" size={12} />}
          </button>
        </div>
      )}
      <div className="chat-body" ref={bodyRef} aria-live="polite">
        {messages.map((m, i) => (
          <Message key={i} message={m} onSuggest={ask} onNavigate={() => setOpen(false)} />
        ))}
        {busy && <p className="bubble assistant typing"><span /><span /><span /></p>}
      </div>
      <form className="chat-input" onSubmit={send}>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. headphones under ₹3,000"
          aria-label="Message"
          maxLength={500}
        />
        <button type="submit" disabled={busy || !input.trim()} aria-label="Send"><Icon name="send" size={18} /></button>
      </form>
    </div>
  );
}
