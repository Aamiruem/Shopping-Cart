import { useState } from 'react';
import { api, downloadFile } from '../../api/client';
import CustomersTab from '../../components/analytics/CustomersTab';
import ForecastTab from '../../components/analytics/ForecastTab';
import OverviewTab from '../../components/analytics/OverviewTab';
import ProductsTab from '../../components/analytics/ProductsTab';
import SupportTab from '../../components/analytics/SupportTab';
import { ErrorMessage, Spinner } from '../../components/common/Feedback';
import Icon from '../../components/common/Icon';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import useApi from '../../hooks/useApi';

const TABS = [
  { id: 'overview', label: 'Overview', load: (p) => api.analyticsOverview(p), Component: OverviewTab },
  { id: 'forecast', label: 'Sales forecast', load: (p) => api.analyticsForecast(p), Component: ForecastTab },
  { id: 'products', label: 'Best-seller prediction', load: (p) => api.analyticsBestsellers(p), Component: ProductsTab },
  { id: 'customers', label: 'Customers & churn', load: (p) => api.analyticsCustomers(p), Component: CustomersTab },
  { id: 'support', label: 'Support', load: () => api.analyticsSupport(), Component: SupportTab, adminOnly: true },
];
const PERIODS = [7, 30, 90, 180];

function TabPanel({ tab, params }) {
  const { data, error, loading, reload } = useApi(() => tab.load(params), [tab.id, params.days, params.sellerId]);
  if (loading) return <div className="tab-loading"><Spinner label="Crunching the numbers…" /><p className="muted small">Training models on your latest data…</p></div>;
  if (error) return <ErrorMessage message={error} onRetry={reload} />;
  return <tab.Component data={data} />;
}

export default function AnalyticsDashboard() {
  const { user } = useAuth();
  const toast = useToast();
  const isAdmin = user.role === 'admin';
  const [tabId, setTabId] = useState('overview');
  const [days, setDays] = useState(30);
  const [sellerId, setSellerId] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const { data: sellers } = useApi(() => (isAdmin ? api.analyticsSellers() : Promise.resolve([])), [isAdmin]);

  const tabs = TABS.filter((t) => !t.adminOnly || isAdmin);
  const tab = tabs.find((t) => t.id === tabId) || tabs[0];
  const params = { days: tab.id === 'overview' ? days : undefined, sellerId: sellerId || undefined };

  const exportCsv = async (dataset) => {
    try {
      await downloadFile(api.exportUrl({ dataset, sellerId: sellerId || undefined }), `arvixa-${dataset}.csv`);
    } catch (err) {
      toast.show(err.message, 'error');
    }
  };

  const retrain = async () => {
    try {
      await api.analyticsRetrain();
      setRefreshKey((k) => k + 1);
      toast.show('Models will retrain on the latest data');
    } catch (err) {
      toast.show(err.message, 'error');
    }
  };

  return (
    <div className="dashboard">
      <header className="dash-head">
        <div>
          <h1>Analytics & AI insights</h1>
          <p className="muted small">{isAdmin && !sellerId ? 'Whole marketplace' : isAdmin ? 'One store' : `Your store · ${user.storeName}`} · machine-learning models retrain every 30 minutes</p>
        </div>
        <div className="dash-filters">
          {isAdmin && (
            <select className="select-sm" value={sellerId} onChange={(e) => setSellerId(e.target.value)} aria-label="Store">
              <option value="">All stores</option>
              {(sellers || []).map((s) => <option key={s.id} value={s.id}>{s.storeName}</option>)}
            </select>
          )}
          {tab.id === 'overview' && (
            <div className="segmented" role="group" aria-label="Period">
              {PERIODS.map((p) => <button key={p} type="button" className={days === p ? 'active' : ''} onClick={() => setDays(p)}>{p}d</button>)}
            </div>
          )}
          <button type="button" className="btn btn-outline btn-sm" onClick={() => exportCsv('orders')}><Icon name="download" size={14} /> Orders CSV</button>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => exportCsv('products')}><Icon name="download" size={14} /> Products CSV</button>
          {isAdmin && <button type="button" className="btn btn-outline btn-sm" onClick={retrain}><Icon name="returns" size={14} /> Retrain</button>}
        </div>
      </header>

      <nav className="dash-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === tab.id} className={t.id === tab.id ? 'active' : ''} onClick={() => setTabId(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <TabPanel key={`${tab.id}-${refreshKey}`} tab={tab} params={params} />
    </div>
  );
}
