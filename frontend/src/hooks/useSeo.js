import { useEffect } from 'react';
import { SHOPPING, SITE_URL } from '../config';
import { HOME_TITLE, LOGO_PATH, productPath, SHARE_IMAGE_PATH, SITE_NAME, slugify, SLOGAN } from '../seo/copy';

export { productPath, slugify };

// Always the public address, so a deployment's secondary *.vercel.app URLs never become the canonical one
export const absolute = (url) => (url && !/^https?:/.test(url) ? `${SITE_URL}${url.startsWith('/') ? '' : '/'}${url}` : url);

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
    const fullTitle = title ? `${title} | ${SITE_NAME}` : HOME_TITLE;
    const url = absolute(path ?? `${window.location.pathname}${window.location.search}`);
    document.title = fullTitle;
    setMeta('name', 'description', description);
    setMeta('name', 'robots', noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large');
    setLink('canonical', url);
    setMeta('property', 'og:site_name', SITE_NAME);
    setMeta('property', 'og:type', type);
    setMeta('property', 'og:title', fullTitle);
    setMeta('property', 'og:description', description);
    setMeta('property', 'og:url', url);
    setMeta('property', 'og:image', absolute(image || SHARE_IMAGE_PATH));
    setMeta('name', 'twitter:card', 'summary_large_image');
    setMeta('name', 'twitter:title', fullTitle);
    setMeta('name', 'twitter:description', description);
    setMeta('name', 'twitter:image', absolute(image || SHARE_IMAGE_PATH));

    document.head.querySelectorAll('script[data-seo]').forEach((el) => el.remove());
    const data = JSON.parse(ld);
    (Array.isArray(data) ? data : [data]).filter(Boolean).forEach((item) => {
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

// Google's Product rich results need a real offer: sent once the store takes orders at these prices (store and live
// modes), never in browse-only preview. aggregateRating comes from real buyers' reviews only.
export const productLd = (p) => (!SHOPPING ? null : {
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
    seller: { '@type': 'Organization', name: SITE_NAME },
  },
  ...(p.reviewCount > 0
    ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: p.reviewRating, reviewCount: p.reviewCount, bestRating: 5 } }
    : {}),
});

export const homeLd = () => [
  { '@type': 'Organization', '@id': `${SITE_URL}/#organization`, name: SITE_NAME, url: `${SITE_URL}/`, logo: absolute(LOGO_PATH), slogan: SLOGAN },
  {
    '@type': 'WebSite',
    '@id': `${SITE_URL}/#website`,
    name: SITE_NAME,
    url: `${SITE_URL}/`,
    inLanguage: 'en-IN',
    publisher: { '@id': `${SITE_URL}/#organization` },
    potentialAction: { '@type': 'SearchAction', target: `${SITE_URL}/products?q={search_term_string}`, 'query-input': 'required name=search_term_string' },
  },
];

export const itemListLd = (products) => ({
  '@type': 'ItemList',
  itemListElement: products.slice(0, 30).map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: absolute(productPath(p)), name: p.name })),
});
