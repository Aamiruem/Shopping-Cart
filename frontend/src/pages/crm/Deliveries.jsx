import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, count, dateTime, ErrorBox, Kpi, label, Loading, money, PageHead, Pager, Table, useCrmData } from '../../components/crm/ui';

// Shipments booked with the courier: real AWB numbers and the courier's own tracking events only
export default function Deliveries() {
  const [params, setParams] = useState({ q: '', status: '', page: 1 });
  const { data, error, loading, reload } = useCrmData('/shipments', params);
  return (
    <>
      <PageHead title="Deliveries" subtitle="Courier shipments and tracking, updated by the courier’s webhook" />
      {data && !data.connected && <div className="alert warn">No courier is connected. Add SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD, SHIPROCKET_PICKUP_POSTCODE and SHIPROCKET_WEBHOOK_TOKEN in Vercel. Until then, enter tracking numbers by hand on each order (only ones the courier actually issued).</div>}
      {data && (
        <div className="kpis">
          <Kpi label="Waiting to ship" value={count(data.toShip)} sub={<Link to="/crm/sales?fulfilment=pending">Open orders</Link>} />
          {data.counts.map((c) => <Kpi key={c.status} label={label(c.status)} value={count(c.n)} />)}
        </div>
      )}
      <section className="card flush">
        <div className="toolbar">
          <input type="search" placeholder="AWB, order number or customer" value={params.q} onChange={(e) => setParams({ ...params, q: e.target.value, page: 1 })} aria-label="Search shipments" />
          <select value={params.status} onChange={(e) => setParams({ ...params, status: e.target.value, page: 1 })} aria-label="Status">
            <option value="">Every status</option>{['awb_assigned', 'shipped', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_attempted', 'returning_to_seller', 'returned_to_seller'].map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
        </div>
        <ErrorBox error={error} onRetry={reload} />
        {loading && !data ? <Loading /> : (
          <Table rows={data?.items} empty="No shipments booked with a courier yet" columns={[
            { key: 'order', label: 'Order', render: (s) => <Link to={`/crm/sales?order=${s.order_id}`}>{s.order_number}</Link> },
            { key: 'customer', label: 'Customer', render: (s) => <>{s.customer}<span className="sub">{s.payment_method === 'cod' ? `COD ${money(s.total)}` : 'Prepaid'}</span></> },
            { key: 'awb', label: 'Courier / AWB', render: (s) => <>{s.courier || '—'}<span className="sub">{s.awb ? (s.tracking_url ? <a href={s.tracking_url} target="_blank" rel="noreferrer">{s.awb}</a> : s.awb) : 'not assigned'}</span></> },
            { key: 'status', label: 'Status', render: (s) => <><Badge value={s.status === 'delivered' ? 'delivered' : s.status}>{label(s.status)}</Badge>{s.last_location && <span className="sub">{s.last_location}</span>}</> },
            { key: 'eta', label: 'ETA', hideSm: true, render: (s) => (s.eta ? String(s.eta).slice(0, 10) : '—') },
            { key: 'last_event_at', label: 'Last update', render: (s) => dateTime(s.last_event_at || s.updated_at) },
          ]} />
        )}
        <Pager data={data} onPage={(page) => setParams({ ...params, page })} />
      </section>
    </>
  );
}
