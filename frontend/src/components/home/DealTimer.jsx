import { useEffect, useState } from 'react';
import Icon from '../common/Icon';

// Counts down to midnight, when "Deals of the Day" refresh
function remaining() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const s = Math.floor((midnight - now) / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

export default function DealTimer() {
  const [time, setTime] = useState(remaining);
  useEffect(() => {
    const id = setInterval(() => setTime(remaining()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="deal-timer">
      <Icon name="clock" size={16} /> <span>{time} Left</span>
    </span>
  );
}
