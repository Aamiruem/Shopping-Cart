import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { crm } from '../../api/client';
import Icon from '../../components/common/Icon';
import { Badge, count, dateTime, Drawer, ErrorBox, Field, Kpi, label, Loading, Modal, PageHead, Pager, pctText, Table, useAction, useCrm, useCrmData } from '../../components/crm/ui';

const SEGMENTS = { '': 'Everyone who agreed', new: 'New customers', one_time: 'One-time buyers', returning: 'Returning', loyal: 'Loyal', at_risk: 'At risk', lost: 'Lost', prospect: 'Signed up, never ordered' };

function CampaignForm({ initial, onClose, onSaved }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({ name: '', kind: 'promotional', channel: 'email', subject: '', body: 'Hi {{name}},\n\n', templateName: '', couponCode: '', audience: { segment: '', tag: '', subscribers: true, leads: false }, ...initial });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const aud = (k, v) => setF({ ...f, audience: { ...f.audience, [k]: v } });
  const save = async (e) => {
    e.preventDefault();
    const body = { ...f, audience: { ...f.audience, segment: f.audience.segment || null, tag: f.audience.tag || null } };
    const out = await run(() => (initial?.id ? crm.patch(`/campaigns/${initial.id}`, body) : crm.post('/campaigns', body)), 'Campaign saved as a draft');
    if (out) onSaved(out);
  };
  return (
    <Modal title={initial?.id ? 'Edit campaign' : 'New campaign'} onClose={onClose} size="lg">
      <form className="stack" onSubmit={save}>
        <div className="grid3">
          <Field label="Name (internal)"><input required minLength={3} value={f.name} onChange={set('name')} /></Field>
          <Field label="Type"><select value={f.kind} onChange={set('kind')}><option value="promotional">Promotional</option><option value="newsletter">Newsletter</option><option value="retention">Retention / win-back</option><option value="follow_up">Follow-up</option></select></Field>
          <Field label="Channel"><select value={f.channel} onChange={set('channel')}><option value="email">Email</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option></select></Field>
        </div>
        <div className="grid3">
          <Field label="Customer segment"><select value={f.audience.segment || ''} onChange={(e) => aud('segment', e.target.value)}>{Object.entries(SEGMENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Only customers tagged"><input value={f.audience.tag || ''} onChange={(e) => aud('tag', e.target.value)} placeholder="optional" /></Field>
          <Field label="Coupon to track" hint="Orders using it after sending are counted"><input value={f.couponCode || ''} onChange={set('couponCode')} placeholder="DIWALI20" /></Field>
        </div>
        {f.channel === 'email' && !f.audience.segment && !f.audience.tag && (
          <div className="row">
            <label className="check"><input type="checkbox" checked={f.audience.subscribers !== false} onChange={(e) => aud('subscribers', e.target.checked)} /> Newsletter subscribers</label>
            <label className="check"><input type="checkbox" checked={Boolean(f.audience.leads)} onChange={(e) => aud('leads', e.target.checked)} /> Leads who agreed to marketing</label>
          </div>
        )}
        {f.channel === 'email' && <Field label="Subject"><input required minLength={3} value={f.subject || ''} onChange={set('subject')} /></Field>}
        {f.channel === 'whatsapp' && <Field label="Approved WhatsApp template name" hint="Marketing template with one body variable; the message below fills it. Empty = WHATSAPP_MARKETING_TEMPLATE."><input value={f.templateName || ''} onChange={set('templateName')} pattern="[a-z0-9_]*" /></Field>}
        <Field label="Message" hint={`{{name}} becomes the person’s first name. ${f.channel === 'email' ? 'An unsubscribe link is added automatically.' : f.channel === 'sms' ? '“Reply STOP to opt out” is added. Indian SMS needs a DLT-registered template.' : ''}`}>
          <textarea rows={8} required minLength={5} value={f.body} onChange={set('body')} />
        </Field>
        <p className="muted small">Only people who agreed to this channel, and never unsubscribed or bounced, receive it. You review the audience before anything is sent.</p>
        <div className="crm-modal-foot"><button type="button" className="b" onClick={onClose}>Cancel</button><button type="submit" className="b primary" disabled={busy}>Save draft</button></div>
      </form>
    </Modal>
  );
}

function CampaignDrawer({ id, onClose, onChange }) {
  const { can, confirm, toast } = useCrm();
  const { data: c, error, reload } = useCrmData(`/campaigns/${id}`);
  const [editing, setEditing] = useState(false);
  const [progress, setProgress] = useState(null);
  const { run, busy } = useAction();
  const send = async () => {
    if (!(await confirm({ title: `Send “${c.name}”?`, message: `It goes to ${c.audienceSize} people by ${c.channel} now. This can’t be undone.`, confirmLabel: 'Send now' }))) return;
    let first = true;
    for (;;) {
      try {
        // Batches: a serverless function has a time limit, so the page asks for the next batch until all are sent
        const out = await crm.post(`/campaigns/${id}/send`, first ? { confirm: true } : {});
        first = false;
        setProgress(out);
        if (out.done || !out.sentThisBatch) break;
      } catch (err) {
        toast(err.message, 'error');
        break;
      }
    }
    reload();
    onChange();
  };
  const stop = async () => {
    if ((await confirm({ title: 'Stop sending?', message: 'Messages not yet sent are cancelled.', danger: true, confirmLabel: 'Stop' })) && (await run(() => crm.post(`/campaigns/${id}/cancel`), 'Campaign stopped'))) reload();
  };
  const retry = async () => {
    if (await run(() => crm.post('/messages/retry', { campaignId: id }), (r) => `Retried ${r.retried}: ${r.accepted} accepted, ${r.failed} failed again`)) reload();
  };
  const remove = async () => {
    if ((await confirm({ title: 'Delete this campaign?', message: 'Its results stay in the communication log.', danger: true, confirmLabel: 'Delete' })) && (await run(() => crm.del(`/campaigns/${id}`), 'Deleted'))) {
      onChange();
      onClose();
    }
  };
  const s = c?.stats;
  return (
    <Drawer title={c?.name || 'Campaign'} onClose={onClose}>
      <ErrorBox error={error} onRetry={reload} />
      {!c ? <Loading /> : (
        <div className="stack">
          <div className="row"><Badge value={c.status} /><Badge tone="info">{c.channel}</Badge><span className="muted small">{label(c.kind)}{c.sent_at ? ` · sent ${dateTime(c.sent_at)}` : ''}</span></div>
          {c.status === 'draft' && (
            <section className="card">
              <h3>Audience right now: {count(c.audienceSize)} people</h3>
              {c.audiencePreview?.map((p, i) => <div key={i} className="small">{p.name || '—'} · {p.address}</div>)}
              {c.audienceSize === 0 && <p className="muted">Nobody in this audience has agreed to {c.channel} messages yet.</p>}
              {can('marketing.send') && (
                <div className="row" style={{ marginTop: 12 }}>
                  <button type="button" className="b primary" disabled={busy || !c.audienceSize} onClick={send}><Icon name="send" size={15} /> Send to {c.audienceSize}</button>
                  <button type="button" className="b" onClick={() => setEditing(true)}>Edit</button>
                  <button type="button" className="b danger" onClick={remove}>Delete</button>
                </div>
              )}
            </section>
          )}
          {progress && !progress.done && <div className="alert info">Sending… {progress.accepted + progress.failed} of {progress.recipients}</div>}
          {s.recipients > 0 && (
            <div className="kpis">
              <Kpi label="Recipients" value={count(s.recipients)} sub={s.queued ? `${s.queued} waiting` : ''} />
              <Kpi label="Accepted by provider" value={count(s.accepted)} />
              <Kpi label="Delivered" value={count(s.delivered)} sub={`${pctText(s.deliveryRate)} · reported by the provider`} />
              <Kpi label="Opened" value={count(s.opened)} sub={pctText(s.openRate)} />
              <Kpi label="Clicked" value={count(s.clicked)} sub={pctText(s.clickRate)} />
              <Kpi label="Failed / bounced" value={count(s.failed + s.bounced)} />
            </div>
          )}
          {c.coupon && <section className="card"><h3>Coupon {c.coupon_code}</h3><p className="small">{c.coupon.orders} orders used it since sending ({c.coupon.from_recipients} from recipients), worth ₹{Math.round(c.coupon.revenue).toLocaleString('en-IN')}.</p></section>}
          <div className="row">
            {c.status === 'sending' && can('marketing.send') && <><button type="button" className="b primary" onClick={send}>Continue sending</button><button type="button" className="b danger" onClick={stop}>Stop</button></>}
            {s.failed > 0 && can('marketing.send') && <button type="button" className="b" onClick={retry} disabled={busy}>Retry failed</button>}
          </div>
          <section className="card"><h3>Message</h3>{c.subject && <p><strong>{c.subject}</strong></p>}<p style={{ whiteSpace: 'pre-wrap' }}>{c.body}</p></section>
          {c.messages.length > 0 && (
            <section className="card flush">
              <Table rows={c.messages} columns={[{ key: 'to_address', label: 'To' }, { key: 'status', label: 'Status', render: (m) => <><Badge value={m.status} />{m.error && <span className="sub">{m.error}</span>}</> }, { key: 'status_at', label: 'Updated', render: (m) => dateTime(m.status_at || m.created_at) }]} />
            </section>
          )}
        </div>
      )}
      {editing && <CampaignForm initial={{ ...c, templateName: c.template_name, couponCode: c.coupon_code }} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
    </Drawer>
  );
}

function Log() {
  const { can } = useCrm();
  const [params, setParams] = useState({ channel: '', status: '', kind: '', page: 1 });
  const { data, error, loading, reload } = useCrmData('/messages', params);
  const { run, busy } = useAction();
  const set = (k) => (e) => setParams({ ...params, [k]: e.target.value, page: 1 });
  return (
    <section className="card flush">
      <div className="toolbar">
        <select value={params.channel} onChange={set('channel')} aria-label="Channel"><option value="">All channels</option><option value="email">Email</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option></select>
        <select value={params.kind} onChange={set('kind')} aria-label="Type"><option value="">All types</option><option value="transactional">Order & account updates</option><option value="campaign">Campaigns</option><option value="automation">Automations</option><option value="manual">Sent by the team</option><option value="inbound">Received</option></select>
        <select value={params.status} onChange={set('status')} aria-label="Status"><option value="">Any status</option>{['queued', 'accepted', 'delivered', 'opened', 'clicked', 'bounced', 'failed', 'received'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
        {data?.summary && <span className="muted small">Last 30 days: {data.summary.accepted} accepted, {data.summary.delivered} confirmed delivered, {data.summary.failed} failed</span>}
        {can('marketing.send') && data?.summary?.failed > 0 && <button type="button" className="b sm" disabled={busy} onClick={async () => (await run(() => crm.post('/messages/retry', {}), (r) => `Retried ${r.retried}`)) && reload()}>Retry failed</button>}
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : (
        <Table rows={data?.items} empty="No messages yet. Nothing is sent until a provider is configured." columns={[
          { key: 'created_at', label: 'When', render: (m) => dateTime(m.created_at) },
          { key: 'to_address', label: 'To / from', render: (m) => <>{m.direction === 'in' ? '← ' : ''}{m.to_address}{m.user_id && <span className="sub"><Link to={`/crm/customers/${m.user_id}`}>Customer #{m.user_id}</Link></span>}</> },
          { key: 'channel', label: 'Channel', render: (m) => <>{m.channel}<span className="sub">{label(m.kind)}{m.event ? ` · ${label(m.event)}` : ''}</span></> },
          { key: 'subject', label: 'Subject', hideSm: true, render: (m) => m.subject || '—' },
          { key: 'status', label: 'Status', render: (m) => <><Badge value={m.status} /><span className="sub">{m.provider || ''}{m.attempts > 1 ? ` · ${m.attempts} tries` : ''}</span>{m.error && <span className="sub" style={{ color: 'var(--c-bad)' }}>{m.error}</span>}</> },
        ]} />
      )}
      <Pager data={data} onPage={(page) => setParams({ ...params, page })} />
    </section>
  );
}

function Newsletter() {
  const { can, confirm } = useCrm();
  const [params, setParams] = useState({ status: '', page: 1 });
  const { data, error, reload } = useCrmData('/newsletter', params);
  const { run } = useAction();
  const unsub = async (s) => {
    if ((await confirm({ title: `Unsubscribe ${s.email}?`, message: 'They won’t get marketing emails again unless they sign up themselves.', danger: true, confirmLabel: 'Unsubscribe' })) && (await run(() => crm.post(`/newsletter/${s.id}/unsubscribe`), 'Unsubscribed'))) reload();
  };
  return (
    <section className="card flush">
      <div className="toolbar"><select value={params.status} onChange={(e) => setParams({ status: e.target.value, page: 1 })} aria-label="Show"><option value="">Subscribed</option><option value="unsubscribed">Unsubscribed</option></select></div>
      <ErrorBox error={error} onRetry={reload} />
      <Table rows={data?.items} empty="No subscribers yet: the footer sign-up form adds them" columns={[
        { key: 'email', label: 'Email' }, { key: 'name', label: 'Name', render: (s) => s.name || '—' },
        { key: 'consent_at', label: 'Agreed on', render: (s) => dateTime(s.consent_at) },
        { key: 'x', label: '', render: (s) => s.status !== 'unsubscribed' && can('marketing.send') && <button type="button" className="b sm danger" onClick={() => unsub(s)}>Unsubscribe</button> },
      ]} />
      <Pager data={data} onPage={(page) => setParams({ ...params, page })} />
    </section>
  );
}

export default function Marketing() {
  const { can } = useCrm();
  const [search, setSearch] = useSearchParams();
  const tab = search.get('tab') || 'campaigns';
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useCrmData('/campaigns', { page });
  const [creating, setCreating] = useState(false);
  const { run, busy } = useAction();
  const openId = search.get('campaign');
  const ch = data?.channels;
  return (
    <>
      <PageHead title="Marketing" subtitle="Campaigns, newsletter and automations, sent only to people who agreed">
        {can('marketing.send') && <button type="button" className="b" disabled={busy} onClick={() => run(() => crm.post('/automations/run'), (o) => (o.skipped?.length ? o.skipped.join('. ') : `Automations ran: ${o.abandonedCart} cart reminders, ${o.birthday} birthday, ${o.anniversary} anniversary, ${o.winBack} win-back emails`))}>Run automations now</button>}
        {can('marketing.send') && <button type="button" className="b primary" onClick={() => setCreating(true)}><Icon name="plus" size={15} /> New campaign</button>}
      </PageHead>
      {ch && (!ch.email.configured || !ch.sms.configured || !ch.whatsapp.configured) && (
        <div className="alert warn">
          Not set up yet: {['email', 'sms', 'whatsapp'].filter((c) => !ch[c].configured).map((c) => `${c} (${ch[c].missing.join(', ')})`).join('; ')}. Nothing goes out on these channels until the provider keys are added in Vercel. {can('settings.manage') && <Link to="/crm/settings?tab=integrations">Setup guide</Link>}
        </div>
      )}
      {data && (
        <div className="kpis">
          <Kpi label="Newsletter subscribers" value={count(data.newsletter.subscribers)} sub={`${data.newsletter.unsubscribed} unsubscribed`} />
          <Kpi label="Customers opted in" value={count(data.optIns.email)} sub={`email · ${data.optIns.sms} SMS · ${data.optIns.whatsapp} WhatsApp`} />
          <Kpi label="Suppressed addresses" value={count(data.suppressed)} sub="Unsubscribed or bounced: never mailed" />
        </div>
      )}
      <div className="tabs">
        {[['campaigns', 'Campaigns'], ['log', 'Communication log'], ['newsletter', 'Newsletter']].map(([k, l]) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setSearch({ tab: k })}>{l}</button>)}
      </div>
      {tab === 'campaigns' && (
        <section className="card flush">
          <ErrorBox error={error} onRetry={reload} />
          {loading && !data ? <Loading /> : (
            <Table rows={data?.items} onRow={(c) => setSearch({ tab, campaign: c.id })} empty="No campaigns yet" columns={[
              { key: 'name', label: 'Campaign', render: (c) => <>{c.name}<span className="sub">{label(c.kind)} · {c.channel}</span></> },
              { key: 'status', label: 'Status', render: (c) => <Badge value={c.status} /> },
              { key: 'recipients', label: 'Recipients', num: true, render: (c) => count(c.stats.recipients) },
              { key: 'delivered', label: 'Delivered', num: true, hideSm: true, render: (c) => `${count(c.stats.delivered)} (${pctText(c.stats.deliveryRate)})` },
              { key: 'opened', label: 'Opened', num: true, hideSm: true, render: (c) => pctText(c.stats.openRate) },
              { key: 'sent_at', label: 'Sent', render: (c) => dateTime(c.sent_at) },
            ]} />
          )}
          <Pager data={data} onPage={setPage} />
        </section>
      )}
      {tab === 'log' && <Log />}
      {tab === 'newsletter' && <Newsletter />}
      <p className="muted small">Automations (abandoned-cart reminders, birthday, anniversary and win-back emails) are switched on in Settings and run daily. Every one is sent only with consent and at most once per person and occasion.</p>
      {creating && <CampaignForm onClose={() => setCreating(false)} onSaved={(c) => { setCreating(false); reload(); setSearch({ tab: 'campaigns', campaign: c.id }); }} />}
      {openId && <CampaignDrawer id={openId} onClose={() => setSearch({ tab })} onChange={reload} />}
    </>
  );
}
