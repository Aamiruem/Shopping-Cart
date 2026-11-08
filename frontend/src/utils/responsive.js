// Pure image-URL logic, shared by the browser (utils/image.js) and the prerender step, so the home page's preloaded
// hero photo is the same file the page then asks for.
// Up to 1080 px so phones and laptops with 2x-3x screens get a sharp photo; the browser picks the smallest that fits
const WIDTHS = [384, 640, 828, 1080];
const QUALITY = 85;

const optimizable = (url) => url.startsWith('/catalog/') || url.startsWith('https://cdn.dummyjson.com/') || /^https:\/\/[\w-]+\.public\.blob\.vercel-storage\.com\//.test(url);
const optimized = (url, width) => `/_vercel/image?url=${encodeURIComponent(url)}&w=${width}&q=${QUALITY}`;

export function responsiveSources(url, sizes, optimizerOn) {
  if (!optimizerOn || !optimizable(url)) return { src: url };
  return { src: optimized(url, WIDTHS[1]), srcSet: WIDTHS.map((w) => `${optimized(url, w)} ${w}w`).join(', '), sizes };
}
