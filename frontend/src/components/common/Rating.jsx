import Icon from './Icon';
import { formatCount } from '../../utils/format';

// Green rating pill, e.g. "4.3 ★  (1,234)"
export default function Rating({ value = 0, count, size = 'md' }) {
  const tone = value >= 4 ? 'good' : value >= 3 ? 'ok' : 'low';
  return (
    <span className={`rating rating-${size}`}>
      <span className={`rating-pill ${tone}`}>
        {Number(value).toFixed(1)} <Icon name="star" size={size === 'sm' ? 10 : 12} filled strokeWidth={0} />
      </span>
      {count != null && <span className="rating-count">({formatCount(count)})</span>}
    </span>
  );
}
