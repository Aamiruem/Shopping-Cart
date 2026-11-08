import { useEffect } from 'react';
import { CATEGORY_COLORS } from '../constants/colors';

// Washes the top of the page in the category's colour (grocery green, beauty pink, electronics violet...).
// Set while the page is open and cleared when the shopper leaves, so other pages keep the plain background.
export default function usePageTint(category) {
  const color = CATEGORY_COLORS[category];
  useEffect(() => {
    if (!color) return undefined;
    const root = document.documentElement;
    root.style.setProperty('--page-tint', color);
    root.classList.add('tinted');
    return () => {
      root.style.removeProperty('--page-tint');
      root.classList.remove('tinted');
    };
  }, [color]);
}
