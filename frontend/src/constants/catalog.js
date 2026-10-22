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

// The catalog in two groups, by how often shoppers need things (backend: CATEGORY_GROUPS, `use` filter)
export const CATEGORY_GROUPS = [
  { id: 'daily', label: 'Daily Use', icon: 'home', note: 'Grocery, kitchen & personal care', categories: ['grocery', 'kitchen', 'beauty'] },
  { id: 'general', label: 'General Use', icon: 'package', note: 'Mobiles, electronics, fashion, home & sports', categories: ['mobiles', 'electronics', 'fashion', 'accessories', 'home', 'sports'] },
];
export const groupOf = (categoryId) => CATEGORY_GROUPS.find((g) => g.categories.includes(categoryId));

// Grocery store aisles = `subCategory` of grocery products, in the order shoppers walk them
export const GROCERY_AISLES = [
  { id: 'fruits-vegetables', label: 'Fruits & Vegetables' },
  { id: 'dairy-bread-eggs', label: 'Dairy, Bread & Eggs' },
  { id: 'atta-rice-dal', label: 'Atta, Rice & Dal' },
  { id: 'oil-ghee-masala', label: 'Oil, Ghee & Masala' },
  { id: 'snacks', label: 'Snacks & Biscuits' },
  { id: 'tea-coffee-drinks', label: 'Tea, Coffee & Drinks' },
  { id: 'breakfast-spreads', label: 'Breakfast & Spreads' },
  { id: 'dry-fruits-health', label: 'Dry Fruits & Health' },
  { id: 'meat-fish', label: 'Meat & Fish' },
  { id: 'frozen-desserts', label: 'Frozen & Desserts' },
  { id: 'cleaning-household', label: 'Cleaning & Household' },
  { id: 'pet-care', label: 'Pet Care' },
];
export const aisleLabel = (id) => GROCERY_AISLES.find((a) => a.id === id)?.label || id;

// Fashion is split by who it is for (`audience` on the product)
export const AUDIENCES = [
  { id: 'women', label: 'Women', heading: "Women's Fashion" },
  { id: 'men', label: 'Men', heading: "Men's Fashion" },
];

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
  {
    id: 'grocery',
    eyebrow: 'Arvixa Fresh',
    title: 'Groceries & daily needs',
    subtitle: 'Fruits, atta, dal, snacks & more',
    image: `${IMG}/groceries/strawberry/thumbnail.webp`,
    to: '/grocery',
    theme: 'teal',
  },
  {
    id: 'women',
    eyebrow: 'New Arrivals',
    title: "Women's fashion",
    subtitle: 'Dresses, tops & heels · 360° view',
    image: `${IMG}/womens-dresses/black-women's-gown/thumbnail.webp`,
    to: '/products?category=fashion&audience=women',
    theme: 'rose',
  },
];

export const PROMO_VIDEO = {
  src: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
  poster: `${IMG}/home-decoration/plant-pot/thumbnail.webp`,
};
