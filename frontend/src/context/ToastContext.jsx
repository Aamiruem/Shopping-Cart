import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import Icon from '../components/common/Icon';

const ToastContext = createContext(null);
let nextId = 1;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  // type: 'success' | 'error' | 'info'
  const show = useCallback((message, type = 'success') => {
    const id = nextId++;
    setToasts((list) => [...list.slice(-2), { id, message, type }]);
    setTimeout(() => dismiss(id), 3000);
  }, [dismiss]);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <Icon name={t.type === 'error' ? 'x' : t.type === 'info' ? 'message' : 'check'} size={16} />
            <span>{t.message}</span>
            <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
