import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { crm } from '../../api/client';
import { Badge, dateTime, ErrorBox, Field, label, Loading, PageHead, Pager, Table, useAction, useCrm, useCrmData } from '../../components/crm/ui';

function Section({ title, children, onSave, busy, note }) {
  return (
    <form className="card stack" style={{ marginBottom: 14 }} onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      <h2 style={{ margin: 0 }}>{title}</h2>
      {note && <p className="muted small" style={{ margin: 0 }}>{note}</p>}
      {children}
      <div><button type="submit" className="b primary" disabled={busy}>Save</button></div>
    </form>
  );
}

function General({ data, reload }) {
  const { run, busy } = useAction();
  const [s, setS] = useState(data.settings);
  useEffect(() => setS(data.settings), [data]);
  const save = async (key) => (await run(() => crm.put('/settings', { [key]: s[key] }), 'Settings saved')) && reload();
  const field = (sec, key) => (e) => setS({ ...s, [sec]: { ...s[sec], [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value } });
  return (
    <>
      <Section title="Company (invoices and emails)" onSave={() => save('company')} busy={busy}>
        <div className="grid2">
          <Field label="Store name"><input value={s.company.name} onChange={field('company', 'name')} /></Field>
          <Field label="Registered business name"><input value={s.company.legalName} onChange={field('company', 'legalName')} /></Field>
          <Field label="Registered address"><input value={s.company.address} onChange={field('company', 'address')} /></Field>
          <Field label="GSTIN"><input value={s.company.gstin} onChange={field('company', 'gstin')} maxLength={15} /></Field>
          <Field label="Contact email"><input type="email" value={s.company.email} onChange={field('company', 'email')} /></Field>
          <Field label="Contact phone"><input value={s.company.phone} onChange={field('company', 'phone')} /></Field>
          <Field label="Invoice number prefix"><input value={s.company.invoicePrefix} onChange={field('company', 'invoicePrefix')} maxLength={10} /></Field>
        </div>
      </Section>
      <Section title="Order and account notifications" onSave={() => save('notifications')} busy={busy} note="A channel only sends once its provider is set up (Integrations). Texts go only to verified mobile numbers. WhatsApp needs an approved utility template.">
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Event</th><th>Email</th><th>SMS</th><th>WhatsApp</th></tr></thead>
            <tbody>
              {Object.entries(data.notificationEvents).map(([e, l]) => (
                <tr key={e}><td>{l}</td>{['email', 'sms', 'whatsapp'].map((ch) => (
                  <td key={ch}><input type="checkbox" aria-label={`${l} by ${ch}`} checked={Boolean(s.notifications[e]?.[ch])} onChange={(ev) => setS({ ...s, notifications: { ...s.notifications, [e]: { ...s.notifications[e], [ch]: ev.target.checked } } })} /></td>
                ))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Lead capture" onSave={() => save('leads')} busy={busy}>
        <label className="check"><input type="checkbox" checked={s.leads.registrationLeads} onChange={field('leads', 'registrationLeads')} /> A lead for every sign-up that hasn’t ordered yet</label>
        <label className="check"><input type="checkbox" checked={s.leads.abandonedCartLeads} onChange={field('leads', 'abandonedCartLeads')} /> A lead for carts left without an order</label>
        <label className="check"><input type="checkbox" checked={s.leads.autoAssign} onChange={field('leads', 'autoAssign')} /> Assign new leads automatically to the sales team member with the fewest open leads</label>
        <div className="grid2">
          <Field label="Cart counts as abandoned after (hours)"><input type="number" min={1} max={168} value={s.leads.abandonedCartHours} onChange={field('leads', 'abandonedCartHours')} /></Field>
          <Field label="Repeat enquiries from the same person merge within (hours)"><input type="number" min={1} max={720} value={s.leads.duplicateWindowHours} onChange={field('leads', 'duplicateWindowHours')} /></Field>
        </div>
      </Section>
      <Section title="Support targets" onSave={() => save('support')} busy={busy}>
        <div className="grid2">
          <Field label="First response within (hours)"><input type="number" min={1} max={240} value={s.support.firstResponseHours} onChange={field('support', 'firstResponseHours')} /></Field>
          <Field label="Resolution within (hours)"><input type="number" min={1} max={720} value={s.support.resolutionHours} onChange={field('support', 'resolutionHours')} /></Field>
        </div>
      </Section>
      <Section title="Marketing automations (email, with consent only)" onSave={() => save('automations')} busy={busy} note="Run daily by the scheduled job, or with “Run automations now” on the Marketing page. Each goes once per person and occasion.">
        <label className="check"><input type="checkbox" checked={s.automations.abandonedCartReminder} onChange={field('automations', 'abandonedCartReminder')} /> Abandoned-cart reminder</label>
        <Field label="Coupon to mention in the reminder (optional, must exist)"><input value={s.automations.abandonedCartCoupon} onChange={field('automations', 'abandonedCartCoupon')} /></Field>
        <label className="check"><input type="checkbox" checked={s.automations.birthday} onChange={field('automations', 'birthday')} /> Birthday greeting (when a birthday is on the customer’s profile)</label>
        <Field label="Birthday coupon (optional, must exist)"><input value={s.automations.birthdayCoupon} onChange={field('automations', 'birthdayCoupon')} /></Field>
        <label className="check"><input type="checkbox" checked={s.automations.anniversary} onChange={field('automations', 'anniversary')} /> Anniversary greeting</label>
        <label className="check"><input type="checkbox" checked={s.automations.winBack} onChange={field('automations', 'winBack')} /> Win-back email after</label>
        <Field label="Days since the last order"><input type="number" min={30} max={730} value={s.automations.winBackDays} onChange={field('automations', 'winBackDays')} /></Field>
      </Section>
    </>
  );
}

function Status({ ok, children }) {
  return <Badge tone={ok ? 'good' : 'warn'}>{children || (ok ? 'Configured' : 'Not configured')}</Badge>;
}

function Integrations() {
  const { data, error, reload } = useCrmData('/integrations');
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;
  const m = data.messaging;
  const rows = [
    ['Email', m.email.configured, `${label(m.email.provider)}${m.email.missing.length ? ` · missing ${m.email.missing.join(', ')}` : ''}`, data.setup.email, m.webhooks.resend ? 'Delivery reports on' : 'No delivery reports (set RESEND_WEBHOOK_SECRET)'],
    ['SMS', m.sms.configured, `${label(m.sms.provider)}${m.sms.missing.length ? ` · missing ${m.sms.missing.join(', ')}` : ''}`, data.setup.sms, m.sms.provider === 'twilio' ? 'Twilio status callbacks' : 'MSG91 delivery reports in its dashboard'],
    ['WhatsApp', m.whatsapp.configured, `Meta Cloud API${m.whatsapp.missing.length ? ` · missing ${m.whatsapp.missing.join(', ')}` : ''} · update template ${m.whatsapp.templates.updates || 'not set'} · marketing template ${m.whatsapp.templates.marketing || 'not set'}`, data.setup.whatsapp, m.webhooks.whatsapp ? 'Webhook verified' : 'Webhook not set (WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN)'],
  ];
  return (
    <div className="stack">
      <div className="alert info">Keys are set in Vercel → Project → Settings → Environment Variables (Production), then redeploy. This page shows only whether each is present, never the values. Nothing is ever sent on a channel that isn’t configured, and nothing is marked delivered unless the provider reports it.</div>
      <section className="card flush">
        <table className="t">
          <thead><tr><th>Channel</th><th>Status</th><th>Details</th><th className="hide-sm">Delivery tracking</th></tr></thead>
          <tbody>{rows.map(([name, ok, details, , tracking]) => <tr key={name}><td><strong>{name}</strong></td><td><Status ok={ok} /></td><td className="small">{details}</td><td className="small hide-sm">{tracking}</td></tr>)}</tbody>
        </table>
      </section>
      <div className="cards">
        <section className="card"><h3>Login codes (OTP)</h3>{Object.entries(data.otp).map(([ch, s]) => <p key={ch} className="small" style={{ margin: '0 0 4px' }}>{label(ch)}: <Status ok={s.configured} /> {s.missing.length ? `missing ${s.missing.join(', ')}` : label(s.provider)}</p>)}</section>
        <section className="card"><h3>Payments & shipping</h3>
          <p className="small">Razorpay: <Status ok={data.payments.configured} /> webhook <Status ok={data.payments.webhook} /></p>
          <p className="small">Shiprocket: <Status ok={data.shipping.configured} /></p>
          <p className="small">Daily job (CRON_SECRET): <Status ok={data.cron.configured} /></p>
          <p className="small">Site address (SITE_URL): <Status ok={Boolean(data.siteUrl)}>{data.siteUrl || 'Not set'}</Status></p>
        </section>
        {data.webhookUrls && <section className="card"><h3>Webhook addresses to give the providers</h3>{Object.entries(data.webhookUrls).map(([k, v]) => <p key={k} className="small" style={{ margin: '0 0 6px' }}>{label(k)}: <code>{v}</code></p>)}</section>}
      </div>
      <section className="card"><h3>What to set</h3>{Object.entries(data.setup).map(([k, list]) => <div key={k} style={{ marginBottom: 8 }}><strong>{label(k)}</strong><ul className="small" style={{ margin: '4px 0' }}>{list.map((x) => <li key={x}>{x}</li>)}</ul></div>)}</section>
    </div>
  );
}

function Audit() {
  const [params, setParams] = useState({ action: '', entity: '', from: '', to: '', page: 1 });
  const { data, error, loading, reload } = useCrmData('/audit', params);
  const set = (k) => (e) => setParams({ ...params, [k]: e.target.value, page: 1 });
  return (
    <section className="card flush">
      <div className="toolbar">
        <select value={params.action} onChange={set('action')} aria-label="Action"><option value="">All actions</option>{(data?.actions || []).map((a) => <option key={a} value={a}>{a}</option>)}</select>
        <select value={params.entity} onChange={set('entity')} aria-label="Record type"><option value="">All records</option>{['customer', 'lead', 'order', 'ticket', 'campaign', 'staff', 'role', 'settings', 'session', 'task', 'report'].map((e) => <option key={e} value={e}>{label(e)}</option>)}</select>
        <Field label="From"><input type="date" value={params.from} onChange={set('from')} /></Field>
        <Field label="To"><input type="date" value={params.to} onChange={set('to')} /></Field>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : <Table rows={data?.items} empty="Nothing recorded yet" columns={[
        { key: 'created_at', label: 'When', render: (a) => dateTime(a.created_at) },
        { key: 'actor_name', label: 'Who', render: (a) => <>{a.actor_name}<span className="sub">{a.ip}</span></> },
        { key: 'action', label: 'Action', render: (a) => <code>{a.action}</code> },
        { key: 'entity', label: 'Record', render: (a) => (a.entity ? `${a.entity} ${a.entity_id ?? ''}` : '—') },
        { key: 'details', label: 'Details', hideSm: true, render: (a) => <span className="small">{Object.entries(a.details || {}).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ').slice(0, 240)}</span> },
      ]} />}
      <Pager data={data} onPage={(page) => setParams({ ...params, page })} />
    </section>
  );
}

export default function Settings() {
  const { can } = useCrm();
  const [search, setSearch] = useSearchParams();
  const tab = search.get('tab') || 'general';
  const { data, error, reload } = useCrmData('/settings', null, { skip: tab !== 'general' });
  return (
    <>
      <PageHead title="Settings" subtitle="Changes are recorded in the audit log" />
      <div className="tabs">{[['general', 'General'], ['integrations', 'Integrations'], ...(can('audit.view') ? [['audit', 'Audit log']] : [])].map(([k, l]) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setSearch({ tab: k })}>{l}</button>)}</div>
      {tab === 'general' && (data ? <General data={data} reload={reload} /> : error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />)}
      {tab === 'integrations' && <Integrations />}
      {tab === 'audit' && <Audit />}
    </>
  );
}
