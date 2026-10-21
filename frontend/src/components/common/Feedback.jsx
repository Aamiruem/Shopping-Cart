import { Link } from 'react-router-dom';
import Icon from './Icon';

// Small shared building blocks for loading, empty and error states

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="spinner-wrap" role="status">
      <span className="spinner" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function SkeletonGrid({ count = 8 }) {
  return (
    <div className="product-grid">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="product-card skeleton">
          <div className="skeleton-box image" />
          <div className="skeleton-box line" />
          <div className="skeleton-box line short" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon = 'package', title, message, action }) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Icon name={icon} size={48} strokeWidth={1.5} /></div>
      <h2>{title}</h2>
      {message && <p>{message}</p>}
      {action && <Link to={action.to} className="btn btn-primary">{action.label}</Link>}
    </div>
  );
}

export function ErrorMessage({ message, onRetry }) {
  if (!message) return null;
  return (
    <div className="alert alert-error" role="alert">
      <span>{message}</span>
      {onRetry && <button type="button" className="btn-link" onClick={onRetry}>Try again</button>}
    </div>
  );
}
