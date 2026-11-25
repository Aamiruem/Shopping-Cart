// One colour per category, shared by the category bar and the page tint (hooks/usePageTint.js)
export const CATEGORY_COLORS = {
  'for-you': '#f59e0b',
  all: '#6366f1',
  fashion: '#ec4899',
  women: '#db2777',
  men: '#2563eb',
  kids: '#0891b2',
  boys: '#0891b2',
  girls: '#c026d3',
  mobiles: '#0284c7',
  electronics: '#7c3aed',
  beauty: '#e11d48',
  home: '#ea580c',
  kitchen: '#b45309',
  grocery: '#16a34a',
  accessories: '#0891b2',
  sports: '#dc2626',
};

// Swatches for common colour names, used when the seller gave a name but no colour code (product.colorHex wins)
export const COLOR_SWATCHES = {
  black: '#111111', white: '#ffffff', grey: '#8a8f98', gray: '#8a8f98', silver: '#c0c4cc', charcoal: '#36393f',
  red: '#d62f2f', maroon: '#7a1f2b', pink: '#f28cb1', 'hot pink': '#e8408c', purple: '#7b3fb5', lavender: '#b9a5e3',
  blue: '#2f6fd6', navy: '#1f2a44', 'sky blue': '#7cc3ee', teal: '#0f8080', turquoise: '#2ec4b6', green: '#2e9a4b',
  olive: '#6b7135', mint: '#a6e3c8', yellow: '#f5c518', mustard: '#d4a017', orange: '#f07c1f', peach: '#f6b99a',
  brown: '#7b4a2a', tan: '#c69c6d', beige: '#e3d3b4', cream: '#f3ead5', khaki: '#b9a57a', gold: '#d4af37',
  'rose gold': '#d9a294', bronze: '#a8703a',
  multicolour: 'conic-gradient(#e33, #fc3, #3c6, #39f, #93f, #e33)',
  multicolor: 'conic-gradient(#e33, #fc3, #3c6, #39f, #93f, #e33)',
};
