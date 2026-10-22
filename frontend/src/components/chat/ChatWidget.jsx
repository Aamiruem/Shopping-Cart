import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useCart } from '../../context/CartContext';
import { playSound } from '../../utils/sound';
import Icon from '../common/Icon';

const GREETING = { role: 'assistant', content: 'Hi! Ask me about products, delivery, returns or payments.' };

// Two modes: "Ask" = RAG Q&A over products and store policies,
// "Assistant" = agent that can search, recommend and add to your cart.
export default function ChatWidget() {
  const { user } = useAuth();
  const { refresh } = useCart();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('ask');
  const [messages, setMessages] = useState([GREETING]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const switchMode = (next) => {
    setMode(next);
    setMessages([GREETING]);
  };

  const send = async (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    const history = [...messages, { role: 'user', content: text }];
    setMessages(history);
    setInput('');
    setBusy(true);
    try {
      let reply;
      if (mode === 'ask') {
        reply = (await api.ask(text)).answer;
      } else {
        // Skip the local greeting - the agent only needs the real conversation
        const result = await api.agent(history.slice(1).map(({ role, content }) => ({ role, content }))).catch(() => null);
        if (result) {
          reply = result.reply;
          if (result.actions?.some((a) => a.tool === 'add_to_cart')) refresh();
        } else {
          // Agent unavailable (e.g. no LLM key configured): answer from the store knowledge base instead
          reply = (await api.ask(text)).answer;
        }
      }
      setMessages([...history, { role: 'assistant', content: reply }]);
      playSound('click');
    } catch (err) {
      setMessages([...history, { role: 'assistant', content: `Sorry — ${err.message}`, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="chat-fab" onClick={() => setOpen(true)} aria-label="Open help chat">
        <Icon name="message" size={22} />
        <span>Help</span>
      </button>
    );
  }

  return (
    <div className="chat-panel" role="dialog" aria-label="Shopping help">
      <header className="chat-head">
        <div>
          <strong>Veyra Assistant</strong>
          <span>Usually replies instantly</span>
        </div>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close chat"><Icon name="x" size={18} /></button>
      </header>
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
      <div className="chat-body" ref={bodyRef}>
        {messages.map((m, i) => (
          <p key={i} className={`bubble ${m.role} ${m.error ? 'error' : ''}`}>{m.content}</p>
        ))}
        {busy && <p className="bubble assistant typing"><span /><span /><span /></p>}
      </div>
      <form className="chat-input" onSubmit={send}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type your question…" aria-label="Message" />
        <button type="submit" disabled={busy || !input.trim()} aria-label="Send"><Icon name="send" size={18} /></button>
      </form>
    </div>
  );
}
