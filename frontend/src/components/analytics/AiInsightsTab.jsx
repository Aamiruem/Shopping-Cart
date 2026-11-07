import { useState } from 'react';
import { api } from '../../api/client';
import { ModelNote, NotReady, StatTile, fmt } from '../charts/ChartParts';
import SpecChart from '../charts/SpecChart';
import Icon from '../common/Icon';

// "Ask your data": plain-English question -> the AI analyst writes SQL -> answer, chart and table
function AskData({ suggestions, llm, sellerId }) {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const ask = async (q = question) => {
    const text = q.trim();
    if (text.length < 3) return;
    setQuestion(text);
    setBusy(true);
    setError('');
    try {
      setResult(await api.aiAnalyst({ question: text, ...(sellerId ? { sellerId: Number(sellerId) } : {}) }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel ask-data span-all">
      <header className="ask-data-head">
        <span className="ask-data-icon"><Icon name="message" size={18} /></span>
        <div>
          <h3>Ask your data</h3>
          <p className="muted small">
            {llm ? 'Ask anything about your sales - the AI analyst writes the SQL, runs it on read-only data and charts the result.'
              : 'Pick a question below. Add ANTHROPIC_API_KEY to the AI service to ask anything in your own words.'}
          </p>
        </div>
      </header>
      <form className="ask-data-form" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Which categories grew the most this month?" aria-label="Your question" maxLength={500} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || question.trim().length < 3}>{busy ? 'Analysing…' : 'Ask'}</button>
      </form>
      <div className="ask-data-chips" aria-label="Suggested questions">
        {suggestions.map((s) => <button key={s} type="button" className="chip-btn" onClick={() => ask(s)} disabled={busy}>{s}</button>)}
      </div>

      {error && <p className="alert alert-error" role="alert">{error}</p>}
      {result && (
        <div className="ask-data-result" aria-live="polite">
          <p className="ask-data-answer">{result.answer}</p>
          {result.chart && <SpecChart spec={result.chart} subtitle={result.llm ? 'Chart chosen by the AI analyst' : 'Built-in report'} />}
          {!result.chart && result.table?.rows?.length > 0 && (
            <SpecChart spec={{ type: 'bar', title: 'Result', x: result.table.columns[0], y: result.table.columns.slice(1), data: result.table.rows }} />
          )}
          {result.queries?.length > 0 && (
            <details className="ask-data-sql">
              <summary>How this was calculated ({result.queries.length} {result.queries.length === 1 ? 'query' : 'queries'})</summary>
              {result.queries.map((q, i) => (
                <div key={i}>
                  <p className="muted small">{q.purpose}{q.error ? ` - failed: ${q.error}` : ` - ${q.rows} rows`}</p>
                  <pre><code>{q.sql}</code></pre>
                </div>
              ))}
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function Significance({ value }) {
  if (value == null) return null;
  return (
    <span className={`sig-badge ${value ? 'yes' : 'no'}`}>
      <Icon name={value ? 'checkCircle' : 'help'} size={12} /> {value ? 'Statistically significant' : 'Not significant'}
    </span>
  );
}

export default function AiInsightsTab({ data, params }) {
  const { insights, forecast, suggestions } = data;
  const overview = insights.overview;

  return (
    <div className="dash-grid">
      <AskData suggestions={suggestions.questions} llm={suggestions.llm} sellerId={params?.sellerId} />

      {overview && (
        <div className="stat-row span-all">
          <StatTile label={`Orders · last ${insights.days} days`} value={fmt.num(overview.rows.orders)} hint={`${overview.dateRange?.[0]} to ${overview.dateRange?.[1]}`} />
          <StatTile label="Average order value" value={fmt.inr(overview.orderValue.mean)} hint={`Median ${fmt.inr(overview.orderValue.median)}`} />
          <StatTile label="Top 10% of orders" value={`≥ ${fmt.inr(overview.orderValue.p90)}`} hint="90th percentile" />
          <StatTile label="Skewness" value={overview.orderValue.skew.toFixed(1)} hint={overview.orderValue.skew > 1 ? 'A few big orders pull the average up' : 'Fairly symmetric'} />
        </div>
      )}

      {forecast.ready ? (
        <SpecChart
          className="span-all"
          spec={forecast.chart}
          subtitle={forecast.summary}
          height={320}
          footer={(
            <ModelNote
              model={forecast.model}
              metrics={[
                { label: 'Error', value: `${forecast.metrics.mae} units/day`, help: `Mean absolute error on ${forecast.metrics.test_days} held-out days` },
                { label: 'Baseline', value: `${forecast.metrics.naive_mae} units/day`, help: '“Same weekday last week”' },
                { label: 'Inputs', value: forecast.features },
              ]}
            />
          )}
        />
      ) : (
        <div className="span-all"><NotReady reason={forecast.reason} /></div>
      )}

      {overview?.charts.map((c) => <SpecChart key={c.title} spec={c} className="span-all" height={260} />)}

      {insights.insights.map((i) => {
        const note = <p className="insight-method"><Significance value={i.significant} /> <Icon name="barChart" size={12} /> {i.method}</p>;
        return i.chart ? (
          <SpecChart key={i.id} spec={{ ...i.chart, title: i.title }} subtitle={i.finding} height={220} footer={note} />
        ) : (
          <section key={i.id} className="panel insight-card">
            <h3>{i.title}</h3>
            <p>{i.finding}</p>
            {note}
            {i.rows?.length > 0 && (
              <ul className="insight-rows">
                {i.rows.slice(0, 5).map((r) => <li key={r.id}>Order #{r.id} · {fmt.inr(r.total)} · {r.payment_method}{r.city ? ` · ${r.city}` : ''}</li>)}
              </ul>
            )}
          </section>
        );
      })}
      {!overview && <div className="span-all"><NotReady reason="No orders in this period yet." /></div>}
    </div>
  );
}
