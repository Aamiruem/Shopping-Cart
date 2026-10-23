import { useEffect, useRef, useState } from 'react';

// Keeps the navbar and the category tabs pinned together at the top while the page scrolls.
// Its real height (it wraps on phones) is published as --nav-height so sticky sidebars sit just below it.
export default function SiteHeader({ children }) {
  const ref = useRef(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const header = ref.current;
    const publish = () => document.documentElement.style.setProperty('--nav-height', `${header.offsetHeight}px`);
    const observer = new ResizeObserver(publish);
    observer.observe(header);
    publish();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return <div ref={ref} className={`site-header ${scrolled ? 'scrolled' : ''}`}>{children}</div>;
}
