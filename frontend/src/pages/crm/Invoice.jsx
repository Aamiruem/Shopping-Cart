import { useParams } from 'react-router-dom';
import { ErrorBox, Loading, money, useCrmData } from '../../components/crm/ui';

// A printable invoice for one order, from the order as stored (prices, discount, delivery fee) and the company details
// in CRM → Settings. "Print / Save as PDF" uses the browser's own PDF export.
export default function Invoice() {
  const { id } = useParams();
  const { data: inv, error, loading } = useCrmData(`/orders/${id}/invoice`);
  if (!inv) return loading ? <Loading /> : <ErrorBox error={error} />;
  const s = inv.seller;
  return (
    <section className="card" style={{ maxWidth: 820, margin: '0 auto', background: '#fff', color: '#111' }}>
      <div className="row no-print" style={{ justifyContent: 'flex-end', marginBottom: 12 }}><button type="button" className="b primary" onClick={() => window.print()}>Print / Save as PDF</button></div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0 }}>{s.legalName || s.name}</h1>
          {s.address && <p style={{ margin: '4px 0' }}>{s.address}</p>}
          {s.gstin && <p style={{ margin: '4px 0' }}>GSTIN: {s.gstin}</p>}
          {(s.email || s.phone) && <p style={{ margin: '4px 0' }}>{[s.email, s.phone].filter(Boolean).join(' · ')}</p>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <h2 style={{ margin: 0 }}>{s.gstin ? 'Tax invoice' : 'Invoice'}</h2>
          <p style={{ margin: '4px 0' }}>No. {inv.number}</p>
          <p style={{ margin: '4px 0' }}>Order #{inv.orderId} · {new Date(inv.date).toLocaleDateString('en-IN')}</p>
          <p style={{ margin: '4px 0' }}>{inv.paymentMethod === 'cod' ? 'Cash on delivery' : 'Paid online'}</p>
        </div>
      </div>
      <hr />
      <p><strong>Bill to</strong><br />{inv.buyer.name}<br />{inv.buyer.address}<br />{[inv.buyer.email, inv.buyer.phone].filter(Boolean).join(' · ')}</p>
      <table className="t" style={{ color: '#111' }}>
        <thead><tr><th>#</th><th>Item</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {inv.items.map((i, n) => <tr key={n}><td>{n + 1}</td><td>{i.name}{i.options && ` (${Object.values(i.options).join(', ')})`}</td><td className="num">{i.qty}</td><td className="num">{money(i.price)}</td><td className="num">{money(i.amount)}</td></tr>)}
          <tr><td colSpan={4} className="num">Subtotal</td><td className="num">{money(inv.subtotal)}</td></tr>
          {inv.discount > 0 && <tr><td colSpan={4} className="num">Discount{inv.couponCode ? ` (${inv.couponCode})` : ''}</td><td className="num">−{money(inv.discount)}</td></tr>}
          <tr><td colSpan={4} className="num">Delivery</td><td className="num">{money(inv.deliveryFee)}</td></tr>
          <tr><td colSpan={4} className="num"><strong>Total</strong></td><td className="num"><strong>{money(inv.total)}</strong></td></tr>
        </tbody>
      </table>
      <p className="small" style={{ color: '#555' }}>{inv.taxNote} {inv.status === 'returned' ? 'This order was returned.' : ''} Computer-generated invoice.</p>
      {!s.address && <p className="alert warn no-print">Add the company’s legal name, address and GSTIN under CRM → Settings → Company before sending invoices to customers.</p>}
    </section>
  );
}
