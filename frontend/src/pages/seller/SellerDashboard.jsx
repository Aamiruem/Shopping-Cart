import { lazy, useEffect, useState } from 'react';
import { TOKEN_KEY } from '../../api/client';
import { PREVIEW } from '../../config';

const AnalyticsDashboard = lazy(() => import('./AnalyticsDashboard'));
const StoreDashboard = lazy(() => import('./StoreDashboard'));

// The analytics & ML dashboard needs the full Python API. The store API (the live site, npm run local) has no
// /api/analytics, so there the Seller Hub opens on the store dashboard instead of an "opening soon" notice.
export default function SellerDashboard() {
  const [full, setFull] = useState(PREVIEW ? false : null);
  useEffect(() => {
    if (PREVIEW) return;
    let token = '';
    try {
      token = localStorage.getItem(TOKEN_KEY) || '';
    } catch {
      /* no saved session */
    }
    fetch(`${import.meta.env.VITE_API_URL || ''}/api/analytics/sellers`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((res) => setFull(![404, 501, 503].includes(res.status)))
      .catch(() => setFull(false));
  }, []);
  if (full === null) return null;
  return full ? <AnalyticsDashboard /> : <StoreDashboard />;
}
