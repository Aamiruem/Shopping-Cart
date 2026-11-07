// Public store address for canonical links and the sitemap. VITE_SITE_URL wins (set it for a custom domain); on
// Vercel the project's production domain is used, so adding a domain and redeploying updates every page by itself.
export function siteUrl(env = process.env) {
  const domain = env.VERCEL_PROJECT_PRODUCTION_URL;
  return (env.VITE_SITE_URL || (domain ? `https://${domain}` : 'http://localhost:4173')).replace(/\/$/, '');
}
