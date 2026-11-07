import { responsiveSources } from './responsive';

// Phones have 2x-3x screens, so a card shown 180 px wide needs about 540 real pixels to look sharp: srcset lets each
// device pick the size it needs. The Vercel optimizer is off elsewhere (Docker and AWS serve the original files).
const OPTIMIZER_ON = import.meta.env.VITE_IMAGE_OPTIMIZER === 'vercel';

// Props for an <img>. `sizes` says how wide the image is on screen.
export const responsiveImage = (url = '', sizes = '(max-width: 600px) 50vw, 240px') => responsiveSources(url, sizes, OPTIMIZER_ON);
