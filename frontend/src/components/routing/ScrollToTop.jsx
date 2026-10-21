import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

// Scroll to the top on page change, or to the #hash target when there is one
export default function ScrollToTop() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    const target = hash && document.getElementById(hash.slice(1));
    if (target) target.scrollIntoView({ behavior: 'smooth' });
    else window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}
