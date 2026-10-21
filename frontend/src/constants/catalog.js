// Display data for the catalog. Category ids match `category` in backend/src/data/products.json.
export const CATEGORIES = [
  { id: 'mobiles', label: 'Mobiles' },
  { id: 'electronics', label: 'Electronics' },
  { id: 'fashion', label: 'Fashion' },
  { id: 'accessories', label: 'Watches & Bags' },
  { id: 'beauty', label: 'Beauty' },
  { id: 'home', label: 'Home & Furniture' },
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'sports', label: 'Sports' },
  { id: 'grocery', label: 'Grocery' },
];

export const categoryLabel = (id) => CATEGORIES.find((c) => c.id === id)?.label || id;

export const SORT_OPTIONS = [
  { id: 'relevance', label: 'Relevance' },
  { id: 'popularity', label: 'Popularity' },
  { id: 'price_asc', label: 'Price — Low to High' },
  { id: 'price_desc', label: 'Price — High to Low' },
  { id: 'rating', label: 'Top Rated' },
  { id: 'newest', label: 'Newest First' },
];

const IMG = 'https://cdn.dummyjson.com/product-images';

export const HERO_SLIDES = [
  {
    id: 'mobiles',
    eyebrow: 'Big Saving Days',
    title: 'Latest smartphones',
    subtitle: 'From ₹8,299 · No-cost EMI available',
    image: `${IMG}/smartphones/iphone-13-pro/thumbnail.webp`,
    to: '/products?category=mobiles',
    theme: 'blue',
  },
  {
    id: 'electronics',
    eyebrow: 'Work & Play',
    title: 'Laptops & tablets',
    subtitle: 'Up to 25% off on top brands',
    image: `${IMG}/laptops/apple-macbook-pro-14-inch-space-grey/thumbnail.webp`,
    to: '/products?category=electronics',
    theme: 'purple',
  },
  {
    id: 'fashion',
    eyebrow: 'New Season Styles',
    title: 'Fashion for every mood',
    subtitle: 'Min. 40% off · Shirts, dresses & shoes',
    image: `${IMG}/womens-dresses/corset-leather-with-skirt/thumbnail.webp`,
    to: '/products?category=fashion',
    theme: 'orange',
  },
  {
    id: 'home',
    eyebrow: 'Home Makeover',
    title: 'Furniture & decor',
    subtitle: 'Starting ₹999 · Free delivery',
    image: `${IMG}/furniture/annibale-colombo-sofa/thumbnail.webp`,
    to: '/products?category=home',
    theme: 'green',
  },
];

export const PROMO_VIDEO = {
  src: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
  poster: `${IMG}/home-decoration/plant-pot/thumbnail.webp`,
};
