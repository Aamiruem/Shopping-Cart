import { useEffect } from 'react';

const SITE = 'Arvixa';
const DEFAULT_IMAGE = '/brand/arvixa-logo.webp';

export const slugify = (text = '') =>
  text.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80);

export const productPath = (p) => `/products/${p._id || p.id}/${slugify(p.name)}`;

const absolute = (url) => (url && !/^https?:/.test(url) ? `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}` : url);

function setMeta(attr, key, content) {
  let tag = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!content) return tag?.remove();
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute(attr, key);
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', content);
}

function setLink(rel, href) {
  let tag = document.head.querySelector(`link[rel="${rel}"]`);
  if (!tag) {
    tag = document.createElement('link');
    tag.setAttribute('rel', rel);
    document.head.appendChild(tag);
  }
  tag.setAttribute('href', href);
}

// Per-page SEO: title, description, canonical URL, Open Graph / Twitter cards and JSON-LD structured data.
// `jsonLd` is an object or an array of schema.org objects (Product, BreadcrumbList, ItemList, ...).
export default function useSeo({ title, description, path, image, type = 'website', noindex = false, jsonLd }) {
  const ld = JSON.stringify(jsonLd || null);
  useEffect(() => {
    const fullTitle = title ? `${title} | ${SITE}` : `${SITE} — Online Shopping for Mobiles, Fashion, Groceries & More`;
    const url = absolute(path ?? `${window.location.pathname}${window.location.search}`);
    document.title = fullTitle;
    setMeta('name', 'description', description);
    setMeta('name', 'robots', noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large');
    setLink('canonical', url);
    setMeta('property', 'og:site_name', SITE);
    setMeta('property', 'og:type', type);
    setMeta('property', 'og:title', fullTitle);
    setMeta('property', 'og:description', description);
    setMeta('property', 'og:url', url);
    setMeta('property', 'og:image', absolute(image || DEFAULT_IMAGE));
    setMeta('name', 'twitter:card', 'summary_large_image');
    setMeta('name', 'twitter:title', fullTitle);
    setMeta('name', 'twitter:description', description);
    setMeta('name', 'twitter:image', absolute(image || DEFAULT_IMAGE));

    document.head.querySelectorAll('script[data-seo]').forEach((el) => el.remove());
    const data = JSON.parse(ld);
    (Array.isArray(data) ? data : data ? [data] : []).forEach((item) => {
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.dataset.seo = '1';
      script.textContent = JSON.stringify({ '@context': 'https://schema.org', ...item });
      document.head.appendChild(script);
    });
  }, [title, description, path, image, type, noindex, ld]);
}

// schema.org helpers
export const breadcrumbLd = (items) => ({
  '@type': 'BreadcrumbList',
  itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: absolute(it.path) })),
});

export const productLd = (p) => ({
  '@type': 'Product',
  name: p.name,
  description: p.description,
  image: (p.images?.length ? p.images : [p.image]).map(absolute),
  sku: p._id,
  brand: p.brand ? { '@type': 'Brand', name: p.brand } : undefined,
  category: p.category,
  offers: {
    '@type': 'Offer',
    url: absolute(productPath(p)),
    priceCurrency: 'INR',
    price: Number(p.price).toFixed(2),
    availability: p.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    itemCondition: 'https://schema.org/NewCondition',
  },
  ...(p.rating > 0 && p.ratingCount > 0
    ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: p.rating, reviewCount: p.ratingCount, bestRating: 5 } }
    : {}),
});

export const itemListLd = (products) => ({
  '@type': 'ItemList',
  itemListElement: products.slice(0, 30).map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: absolute(productPath(p)), name: p.name })),
});
