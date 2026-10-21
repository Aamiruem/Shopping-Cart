import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import useApi from '../../hooks/useApi';
import Icon from '../common/Icon';
import { ChartCard, ChartTooltip, donutLabel, fmt, ModelNote, StatTile } from '../charts/ChartParts';
import { axisProps, gridProps, INK, SERIES, STATUS } from '../charts/theme';

// Sentiment is polarity, so it uses the diverging pair (red <-> blue) with a neutral grey midpoint
const SENTIMENT_COLORS = { Negative: '#e34948', Neutral: '#c3c2b7', Positive: SERIES[0] };
const PRIORITY = { high: { color: STATUS.critical, icon: 'zap' }, medium: { color: STATUS.warning, icon: 'clock' }, low: { color: STATUS.good, icon: 'check' } };

function TicketQueue() {
  const toast = useToast();
  const [status, setStatus] = useState('open');
  const { data: tickets, loading, reload } = useApi(() => api.tickets({ status }), [status]);

  const update = async (id, next) => {
    try {
      await api.updateTicket(id, next);
      toast.show(`Ticket #${id} marked ${next.replace('_', ' ')}`);
      reload();
    } catch (err) {
      toast.show(err.message, 'error');
    }
  };

  return (
    <ChartCard className="span-all" title="Ticket queue" subtitle="Sorted by ML priority, then newest"
      actions={(
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="select-sm" aria-label="Filter by status">
          <option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option><option value="">All</option>
        </select>
      )}>
      {loading ? <p className="muted">Loading…</p> : (
        <ul className="ticket-list">
          {(tickets || []).slice(0, 25).map((t) => (
            <li key={t.id}>
              <span className="status-pill" style={{ '--status': PRIORITY[t.priority].color }}><Icon name={PRIORITY[t.priority].icon} size={12} /> {t.priority[0].toUpperCase() + t.priority.slice(1)}</span>
              <div className="ticket-main">
                <p><strong>#{t.id} {t.subject}</strong> <span className="chip">{t.categoryLabel}</span> <span className="muted small">· {t.customer_name || 'Customer'} · {fmt.shortDate(t.created_at)}</span></p>
                <p className="muted small ticket-msg">{t.message}</p>
                <details><summary className="small">Suggested reply</summary><p className="small">{t.suggested_reply}</p></details>
              </div>
              <span className={`sentiment ${t.sentiment <= -0.2 ? 'neg' : t.sentiment >= 0.2 ? 'pos' : ''}`} title="Sentiment score (-1 to +1)">
                {Number(t.sentiment) > 0 ? '+' : ''}{Number(t.sentiment).toFixed(2)}
              </span>
              <select value={t.status} onChange={(e) => update(t.id, e.target.value)} className="select-sm" aria-label={`Status of ticket ${t.id}`}>
                <option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option>
              </select>
            </li>
          ))}
          {!tickets?.length && <p className="muted">No tickets here.</p>}
        </ul>
      )}
    </ChartCard>
  );
}

export default function SupportTab({ data }) {
  const count = (list, key) => list.find((x) => x.key === key)?.tickets ?? 0;
  const open = count(data.status, 'open') + count(data.status, 'in_progress');
  const sentiment = ['Negative', 'Neutral', 'Positive'].map((k) => ({ key: k, tickets: count(data.sentiment, k) }));
  const total = sentiment.reduce((s, x) => s + x.tickets, 0);

  return (
    <div className="dash-grid">
      <div className="stat-row span-all">
        <StatTile label="Open tickets" value={fmt.num(open)} hint={`${count(data.priority, 'high')} high priority overall`} />
        <StatTile label="Avg. resolution time" value={data.avgResolutionHours ? `${data.avgResolutionHours} h` : '—'} hint="From ticket to resolved" />
        <StatTile label="Negative sentiment" value={fmt.pct(total ? (count(data.sentiment, 'Negative') / total) * 100 : 0, 0)} hint="Share of all tickets" />
        <StatTile label="Classifier accuracy" value={fmt.pct(data.classifier.crossValidatedAccuracy * 100, 0)} hint={`5-fold cross-validation · ${data.classifier.trainingExamples} examples`} />
      </div>

      <ChartCard title="Tickets by topic" subtitle="Category predicted by the classifier" table={{ columns: [{ key: 'label', label: 'Topic' }, { key: 'tickets', label: 'Tickets', numeric: true }], rows: data.category }}>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data.category} layout="vertical" margin={{ top: 4, right: 40, left: 8, bottom: 0 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="label" width={170} {...axisProps} axisLine={false} interval={0} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
            <Bar dataKey="tickets" name="Tickets" fill={SERIES[0]} radius={[0, 4, 4, 0]} barSize={14}>
              <LabelList dataKey="tickets" position="right" fill={INK.secondary} fontSize={11} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <ModelNote model={data.classifier.model} metrics={[{ label: 'Accuracy', value: fmt.pct(data.classifier.crossValidatedAccuracy * 100, 0) }]} />
      </ChartCard>

      <ChartCard title="Customer sentiment" table={{ columns: [{ key: 'key', label: 'Sentiment' }, { key: 'tickets', label: 'Tickets', numeric: true }], rows: sentiment }}>
        <ResponsiveContainer width="100%" height={260}>
          <PieChart>
            <Pie data={sentiment} dataKey="tickets" nameKey="key" innerRadius="45%" outerRadius="65%" paddingAngle={2} stroke="#fff" strokeWidth={2}
              label={donutLabel(total, 'key')} labelLine={false}>
              {sentiment.map((s) => <Cell key={s.key} fill={SENTIMENT_COLORS[s.key]} />)}
            </Pie>
            <Tooltip content={<ChartTooltip valueFormat={(v) => `${v} tickets`} />} />
          </PieChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Daily ticket volume" subtitle="Last 60 days" table={{ columns: [{ key: 'date', label: 'Date' }, { key: 'tickets', label: 'Tickets', numeric: true }, { key: 'sentiment', label: 'Avg. sentiment', numeric: true }], rows: data.daily }}>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data.daily} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="date" tickFormatter={fmt.shortDate} minTickGap={24} {...axisProps} />
            <YAxis allowDecimals={false} {...axisProps} />
            <Tooltip content={<ChartTooltip labelFormat={(d) => new Date(d).toDateString()} />} cursor={{ fill: 'rgba(42,120,214,0.06)' }} />
            <Bar dataKey="tickets" name="Tickets" fill={SERIES[0]} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Average sentiment per day" subtitle="-1 = angry, 0 = neutral, +1 = happy">
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data.daily} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="date" tickFormatter={fmt.shortDate} minTickGap={24} {...axisProps} />
            <YAxis domain={[-1, 1]} ticks={[-1, -0.5, 0, 0.5, 1]} {...axisProps} />
            <ReferenceLine y={0} stroke={INK.axis} />
            <Tooltip content={<ChartTooltip labelFormat={(d) => new Date(d).toDateString()} valueFormat={(v) => Number(v).toFixed(2)} />} />
            <Line dataKey="sentiment" name="Avg. sentiment" stroke={SERIES[0]} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: '#fff', strokeWidth: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      <TicketQueue />
    </div>
  );
}
