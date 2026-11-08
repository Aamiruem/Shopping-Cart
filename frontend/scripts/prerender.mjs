// Runs after `vite build` for static hosting (Vercel). Writes real HTML for every public page, so search engines and
// link previews get the title, description, schema.org data and content without running JavaScript or calling an API.
// React replaces the static content on load. vercel.json maps the URLs onto these files.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { categories, CATEGORY_GROUPS, listProducts, loadProducts, popular, similar } from '../../api/_catalog.mjs';
import { CATEGORIES, categoryLabel, CATEGORY_GROUPS as GROUP_INFO, HERO_SLIDES } from '../src/constants/catalog.js';
import {
  ABOUT_DESCRIPTION, CATEGORY_INTROS, HOME_TITLE, homeDescription, listingDescription, listingTitle, LOGO_PATH, PRIVACY_DESCRIPTION,
  productDescription, productPath, productTitle, SHARE_IMAGE_PATH, SITE_NAME, SLOGAN,
} from '../src/seo/copy.js';
import { responsiveSources } from '../src/utils/responsive.js';
import { siteUrl } from './site-url.mjs';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const SITE = siteUrl();
const PREVIEW = ['preview', 'store'].includes(process.env.VITE_STORE_MODE);
const template = readFileSync(join(DIST, 'index.html'), 'utf8');

const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const abs = (url) => (/^https?:/.test(url) ? url : `${SITE}${url.startsWith('/') ? '' : '/'}${url}`);
const rupees = (value) => `₹${Math.round(Number(value) || 0).toLocaleString('en-IN')}`;
const priceLabel = (p) => rupees(p.price);

// < is escaped so catalog text can never close the script block
const ld = (item) =>
  `<script type="application/ld+json" data-seo="1">${JSON.stringify({ '@context': 'https://schema.org', ...item }).replace(/</g, '\\u003c')}</script>`;

const breadcrumb = (items) => ({
  '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: abs(path) })),
});

const itemList = (products) => ({
  '@type': 'ItemList',
  itemListElement: products.slice(0, 30).map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: abs(productPath(p)), name: p.name })),
});

const SITE_LD = [
  { '@type': 'Organization', '@id': `${SITE}/#organization`, name: SITE_NAME, url: `${SITE}/`, logo: abs(LOGO_PATH), slogan: SLOGAN },
  {
    '@type': 'WebSite',
    '@id': `${SITE}/#website`,
    name: SITE_NAME,
    url: `${SITE}/`,
    inLanguage: 'en-IN',
    publisher: { '@id': `${SITE}/#organization` },
    potentialAction: { '@type': 'SearchAction', target: `${SITE}/products?q={search_term_string}`, 'query-input': 'required name=search_term_string' },
  },
];

// Mirrors useSeo's tags, so the browser updates these rather than adding duplicates
function head({ title, fullTitle, description, path, image = SHARE_IMAGE_PATH, type = 'website', noindex = false, jsonLd = [], extra = [] }) {
  const titleText = fullTitle || `${title} | ${SITE_NAME}`;
  const url = abs(path);
  const img = abs(image);
  return [
    `<title>${esc(titleText)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<meta name="robots" content="${noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large'}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<link rel="alternate" hreflang="en-in" href="${esc(url)}" />`,
    `<link rel="alternate" hreflang="x-default" href="${esc(url)}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:locale" content="en_IN" />`,
    `<meta property="og:type" content="${type}" />`,
    `<meta property="og:title" content="${esc(titleText)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:image" content="${esc(img)}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${esc(titleText)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${esc(img)}" />`,
    ...extra,
    ...jsonLd.filter(Boolean).map(ld),
  ].join('\n    ');
}

function render(headTags, body) {
  const page = template
    .replace(/<title>[\s\S]*?<\/title>\s*/, '')
    .replace(/<meta (?:name="(?:description|robots|twitter:[\w:]+)"|property="og:[\w:]+")[^>]*>\s*/g, '')
    .replace(/<!-- Link-preview defaults[\s\S]*?-->\s*/, '')
    .replace('</head>', () => `    ${headTags}\n  </head>`);
  return page.replace('<div id="root"></div>', () => `<div id="root"><div class="seo-static">${body}</div></div>`);
}

function write(file, content) {
  const target = join(DIST, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

const page = (file, options, body) => write(file, render(head(options), body));

const NAV = `<nav aria-label="Categories"><a href="/">Home</a>${CATEGORIES.map((c) => ` · <a href="/products?category=${c.id}">${esc(c.label)}</a>`).join('')}</nav>`;
const PREVIEW_NOTE = process.env.VITE_STORE_MODE === 'preview' ? '<p><strong>Coming soon.</strong> Ordering opens shortly, and prices may change.</p>' : '';
const links = (products) => `<ul>${products.map((p) => `<li><a href="${esc(productPath(p))}">${esc(p.name)}</a> ${esc(priceLabel(p))}</li>`).join('')}</ul>`;

function listingPage(file, { heading, path, intro, products, crumbs = [] }) {
  page(file, {
    title: listingTitle(heading, PREVIEW),
    description: listingDescription(heading, products.length, PREVIEW),
    path,
    jsonLd: [breadcrumb([['Home', '/'], ...crumbs, [heading, path]]), itemList(products)],
  }, `${NAV}<h1>${esc(heading)}</h1>${PREVIEW_NOTE}${intro ? `<p>${esc(intro)}</p>` : ''}${links(products)}`);
}

// ---------- Pages ----------

const products = loadProducts();
const shareDescription = homeDescription(PREVIEW);

// The bare app shell: routes that are private or personal, and the 404 page (Vercel serves it with status 404)
const shell = render(head({ fullTitle: SITE_NAME, description: shareDescription, path: '/', noindex: true }), '<p>Loading…</p>');
write('_seo/shell/index.html', shell);
write('404.html', shell);

// The first hero photo is the largest thing on the home page: fetch it before the JavaScript asks for it
const hero = responsiveSources(HERO_SLIDES[0].image, '220px', process.env.VITE_IMAGE_OPTIMIZER === 'vercel');
const heroPreload = `<link rel="preload" as="image" href="${esc(hero.src)}"${hero.srcSet ? ` imagesrcset="${esc(hero.srcSet)}" imagesizes="${hero.sizes}"` : ''} fetchpriority="high" />`;
page('index.html', { fullTitle: HOME_TITLE, description: shareDescription, path: '/', jsonLd: SITE_LD, extra: [heroPreload] },
  `${NAV}<h1>${SITE_NAME}: Online Shopping in India</h1><p>${esc(shareDescription)}</p>${PREVIEW_NOTE}<h2>Shop by category</h2><ul>${categories()
    .map((c) => `<li><a href="/products?category=${c.id}">${esc(categoryLabel(c.id))}</a> (${c.count} products)</li>`).join('')}</ul><h2>Popular products</h2>${links(popular(30))}`);

listingPage('_seo/products/index.html', { heading: 'All Products', path: '/products', products: popular(60) });

CATEGORIES.forEach(({ id, label }) => {
  listingPage(`_seo/category/${id}/index.html`, {
    heading: label,
    path: `/products?category=${id}`,
    intro: CATEGORY_INTROS[id],
    products: listProducts({ category: id, sort: 'popularity' }),
  });
});

Object.entries({ women: "Women's Fashion", men: "Men's Fashion" }).forEach(([audience, heading]) => {
  listingPage(`_seo/category/fashion-${audience}/index.html`, {
    heading,
    path: `/products?category=fashion&audience=${audience}`,
    intro: CATEGORY_INTROS.fashion,
    products: listProducts({ category: 'fashion', audience, sort: 'popularity' }),
    crumbs: [['Fashion', '/products?category=fashion']],
  });
});

Object.keys(CATEGORY_GROUPS).forEach((use) => {
  const group = GROUP_INFO.find((g) => g.id === use);
  listingPage(`_seo/use/${use}/index.html`, { heading: group.label, path: `/products?use=${use}`, intro: group.note, products: listProducts({ use, sort: 'popularity' }) });
});

page('grocery/index.html', {
  title: PREVIEW ? 'Online Grocery Store in India' : 'Online Grocery Shopping',
  description: listingDescription('groceries', listProducts({ category: 'grocery' }).length, PREVIEW),
  path: '/grocery',
  jsonLd: [breadcrumb([['Home', '/'], ['Grocery', '/grocery']])],
}, `${NAV}<h1>Grocery Store</h1>${PREVIEW_NOTE}<p>${esc(CATEGORY_INTROS.grocery)}</p>${links(listProducts({ category: 'grocery', sort: 'popularity', limit: 60 }))}`);

const staticPage = (path, title, description, body) => page(`${path.slice(1)}/index.html`, { title, description, path }, `${NAV}<h1>${esc(title)}</h1><p>${esc(description)}</p>${body}`);

staticPage('/help', 'Help Center - Orders, Payments, Returns & Refunds', `Get help with ${SITE_NAME} orders, delivery, payments, cancellations, returns and refunds.`, PREVIEW_NOTE);
staticPage('/sell', `Sell Online on ${SITE_NAME} - Become a Seller`, `Open your online store on ${SITE_NAME}. List products with photos, videos and 360° views, and grow with sales insights.`, PREVIEW_NOTE);
staticPage('/about', 'About Us', ABOUT_DESCRIPTION, PREVIEW_NOTE);
staticPage('/privacy', 'Privacy Policy', PRIVACY_DESCRIPTION, '');
staticPage('/terms', 'Terms of Use', `The terms for using ${SITE_NAME} and buying from it.`, '');
staticPage('/refunds', 'Cancellation & Refund Policy', `How to cancel a ${SITE_NAME} order and how refunds work.`, '');
staticPage('/shipping', 'Shipping Policy', `Where ${SITE_NAME} delivers and what delivery costs.`, '');

products.forEach((p) => {
  const path = productPath(p);
  const category = categoryLabel(p.category);
  const categoryPath = `/products?category=${p.category}`;
  const images = (p.images?.length ? p.images : [p.image]).filter(Boolean).map(abs);
  const productLd = process.env.VITE_STORE_MODE === 'preview' ? null : { // real offers once the store takes orders
    '@type': 'Product',
    name: p.name,
    description: p.description,
    image: images,
    sku: p._id,
    category: p.category,
    ...(p.brand ? { brand: { '@type': 'Brand', name: p.brand } } : {}),
    offers: {
      '@type': 'Offer',
      url: abs(path),
      priceCurrency: 'INR',
      price: Number(p.price).toFixed(2),
      availability: `https://schema.org/${p.stock > 0 ? 'InStock' : 'OutOfStock'}`,
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: SITE_NAME },
    },
  };
  page(`${path.slice(1)}/index.html`, {
    title: productTitle(p, PREVIEW),
    description: productDescription(p, PREVIEW),
    path,
    image: p.image,
    type: 'product',
    jsonLd: [productLd, breadcrumb([['Home', '/'], [category, categoryPath], [p.name, path]])],
  }, [
    `<nav aria-label="Breadcrumb"><a href="/">Home</a> › <a href="${esc(categoryPath)}">${esc(category)}</a></nav>`,
    `<h1>${esc(p.name)}</h1>`,
    images[0] ? `<img src="${esc(images[0])}" alt="${esc(p.name)}" width="320" height="320" />` : '',
    `<p>${esc([p.brand, p.unit, priceLabel(p)].filter(Boolean).join(' · '))}</p>`,
    `<p>${esc(p.description)}</p>`,
    PREVIEW_NOTE,
    `<h2>More in ${esc(category)}</h2>`,
    links(similar(p._id, 6)),
  ].join(''));
});

// ---------- sitemap.xml, robots.txt, web app manifest ----------

const xml = (value) => esc(value).replace(/'/g, '&apos;');
const entry = (path, images = []) =>
  `<url><loc>${xml(abs(path))}</loc>${images.map((i) => `<image:image><image:loc>${xml(abs(i))}</image:loc></image:image>`).join('')}</url>`;

const staticPaths = [
  '/', '/products', '/grocery', '/sell', '/help', '/about', '/privacy', '/terms', '/refunds', '/shipping',
  ...CATEGORIES.map((c) => `/products?category=${c.id}`),
  '/products?category=fashion&audience=women',
  '/products?category=fashion&audience=men',
  ...Object.keys(CATEGORY_GROUPS).map((use) => `/products?use=${use}`),
];
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${[...staticPaths.map((p) => entry(p)), ...products.map((p) => entry(productPath(p), [p.image].filter(Boolean)))].join('\n')}
</urlset>
`);

// Allow rules matter: Googlebot renders the React pages, which fetch their products from these API routes
write('robots.txt', `User-agent: *
Allow: /
Allow: /api/products
Allow: /api/recommendations/
Disallow: /api/
Disallow: /_seo/
Disallow: /cart
Disallow: /checkout
Disallow: /account
Disallow: /orders
Disallow: /wishlist
Disallow: /seller/
Disallow: /login
Disallow: /register
Disallow: /*?*sort=
Disallow: /*?*q=

Sitemap: ${SITE}/sitemap.xml
`);

write('manifest.webmanifest', JSON.stringify({
  name: SITE_NAME,
  short_name: 'Arvixa',
  description: shareDescription,
  lang: 'en-IN',
  start_url: '/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#2874f0',
  icons: [
    { src: '/brand/arvixa-mark-192.png', sizes: '192x192', type: 'image/png' },
    { src: LOGO_PATH, sizes: '512x512', type: 'image/png' },
  ],
}, null, 2));

console.log(`Prerendered ${products.length} products + ${staticPaths.length} pages for ${SITE} (${process.env.VITE_STORE_MODE || 'live'} mode)`);
