import { useEffect, useRef, useState } from 'react';
import { api, downloadFile } from '../../api/client';
import Icon from '../common/Icon';

const POLL_MS = 1500;

// Per-row outcome table shared by the check (dry run) and the real import
function Results({ results }) {
  const problems = results.filter((r) => r.status === 'error');
  const shown = problems.length ? problems : results;
  return (
    <div className="data-table-wrap import-results">
      <table className="data-table">
        <thead><tr><th className="num">Row</th><th>Product</th><th>Result</th></tr></thead>
        <tbody>
          {shown.slice(0, 200).map((r) => (
            <tr key={r.row}>
              <td className="num">{r.row}</td>
              <td>{r.name || <span className="muted">(no name)</span>}</td>
              <td className={r.status === 'error' ? 'text-error' : 'text-success'}>
                {r.status === 'error' ? r.error : r.status === 'created' ? 'Created' : 'Ready'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length > 200 && <p className="muted small">Showing the first 200 of {shown.length} rows.</p>}
    </div>
  );
}

// Bulk upload: CSV sheet (one product per row) + an optional ZIP of the photos / videos it names.
// Step 1 checks every row without creating anything; step 2 runs the import as a background job and polls it.
export default function BulkImport({ onClose, onImported }) {
  const [sheet, setSheet] = useState(null);
  const [media, setMedia] = useState(null);
  const [phase, setPhase] = useState('pick'); // pick | checking | checked | importing | done
  const [uploadPct, setUploadPct] = useState(0);
  const [check, setCheck] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const busy = phase === 'checking' || phase === 'importing';
  const pickFile = (setter) => (e) => {
    setter(e.target.files[0] || null);
    setCheck(null);
    setPhase('pick');
    setError('');
  };

  const template = () => downloadFile(api.sellerImportTemplateUrl(), 'arvixa-bulk-upload-template.csv').catch((err) => setError(err.message));

  const runCheck = async () => {
    setError('');
    setPhase('checking');
    setUploadPct(0);
    try {
      setCheck(await api.sellerImport(sheet, media, true, setUploadPct));
      setPhase('checked');
    } catch (err) {
      setError(err.message);
      setPhase('pick');
    }
  };

  const poll = async (jobId) => {
    try {
      const status = await api.sellerImportStatus(jobId);
      setJob(status);
      if (status.status === 'running') {
        timer.current = setTimeout(() => poll(jobId), POLL_MS);
        return;
      }
      setPhase('done');
      if (status.status === 'failed') setError(status.error || 'The import stopped unexpectedly.');
      if (status.created) onImported(status.created);
    } catch {
      timer.current = setTimeout(() => poll(jobId), POLL_MS * 2); // brief network blip: keep trying
    }
  };

  const runImport = async () => {
    setError('');
    setPhase('importing');
    setUploadPct(0);
    try {
      const { jobId, total } = await api.sellerImport(sheet, media, false, setUploadPct);
      setJob({ status: 'running', total, done: 0, results: [] });
      poll(jobId);
    } catch (err) {
      setError(err.message);
      setPhase('checked');
    }
  };

  const uploading = busy && !job && uploadPct < 1;
  const failedRows = check ? check.total - check.ok : 0;

  return (
    <div className="otp-overlay" role="dialog" aria-modal="true" aria-labelledby="bulk-import-title">
      <div className="panel product-form bulk-import">
        <header>
          <h2 id="bulk-import-title">Bulk upload products</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" disabled={phase === 'importing'}><Icon name="x" /></button>
        </header>

        <div className="product-form-body">
          <ol className="import-steps muted small">
            <li>Download the template and fill one row per product (up to 1,000). Separate lists with “|”, e.g. <code>S|M|L</code>.</li>
            <li>Put every photo / video the sheet names into one ZIP (up to 1 GB). Full <code>https://</code> links work too.</li>
            <li>Check the files, fix any rows we flag, then import.</li>
          </ol>
          <button type="button" className="btn btn-outline btn-sm import-template" onClick={template}><Icon name="download" size={14} /> Download CSV template</button>

          <div className="import-files">
            <label className="field">
              <span>Product sheet (.csv) *</span>
              <input type="file" accept=".csv,text/csv" onChange={pickFile(setSheet)} disabled={busy || phase === 'done'} />
            </label>
            <label className="field">
              <span>Photos &amp; videos (.zip)</span>
              <input type="file" accept=".zip,application/zip" onChange={pickFile(setMedia)} disabled={busy || phase === 'done'} />
            </label>
          </div>

          {uploading && (
            <div className="import-progress" role="status">
              <span>Uploading… {Math.round(uploadPct * 100)}%</span>
              <progress max="1" value={uploadPct} />
            </div>
          )}
          {busy && !uploading && !job && <p className="muted small" role="status">Checking every row…</p>}

          {check && phase !== 'importing' && phase !== 'done' && (
            <>
              <p className={failedRows ? 'alert alert-error' : 'alert alert-success'} role="status">
                {failedRows
                  ? `${check.ok} of ${check.total} rows are ready. Fix the ${failedRows} row(s) below, or import only the ready ones.`
                  : `All ${check.total} rows look good.`}
              </p>
              {failedRows > 0 && <Results results={check.results} />}
            </>
          )}

          {job && (
            <>
              <div className="import-progress" role="status">
                <span>
                  {job.status === 'running' ? `Importing… ${job.done} of ${job.total}` : `Created ${job.created || 0} of ${job.total} products`}
                </span>
                <progress max={job.total || 1} value={job.status === 'running' ? job.done : job.total} />
              </div>
              {job.results?.some((r) => r.status === 'error') && <Results results={job.results} />}
            </>
          )}
        </div>

        {error && <p className="alert alert-error" role="alert">{error}</p>}
        <footer>
          {phase === 'done' ? (
            <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
          ) : (
            <>
              <button type="button" className="btn-text" onClick={onClose} disabled={phase === 'importing'}>Cancel</button>
              {phase === 'checked' && check.ok > 0 ? (
                <button type="button" className="btn btn-primary" onClick={runImport}>
                  <Icon name="upload" size={16} /> Import {check.ok} product{check.ok === 1 ? '' : 's'}
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={runCheck} disabled={!sheet || busy}>
                  {phase === 'checking' ? 'Checking…' : 'Check files'}
                </button>
              )}
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
