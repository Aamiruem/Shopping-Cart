// Downloads for CRM tables and reports: CSV, Excel (.xlsx) and PDF (the browser's "Save as PDF" on a print view).
// The .xlsx is a real Office Open XML workbook, written here as a stored (uncompressed) ZIP: no library needed.

const cellText = (v) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function toCsv(columns, rows) {
  // Cells that start like a formula are prefixed so a spreadsheet never runs them (CSV injection)
  const esc = (v) => {
    let s = cellText(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => esc(c.label ?? c)).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.key ?? c])).join(','))].join('\r\n');
}

function save(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const downloadCsv = (filename, columns, rows) => save(new Blob([String.fromCharCode(0xfeff), toCsv(columns, rows)], { type: 'text/csv;charset=utf-8' }), `${filename}.csv`);

// ---------- XLSX ----------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = enc.encode(content);
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(8, 0, true); // stored
    header.setUint32(14, crc, true);
    header.setUint32(18, data.length, true);
    header.setUint32(22, data.length, true);
    header.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(header.buffer), nameBytes, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

const xml = (s) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]).replace(/[^\t\n\r -￿]/gu, ''); // characters XML forbids
const colName = (i) => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

export function toXlsx(sheetName, columns, rows) {
  const cell = (v, r, c) => {
    const ref = `${colName(c)}${r}`;
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
    const s = cellText(v);
    return s ? `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(s)}</t></is></c>` : '';
  };
  const header = `<row r="1">${columns.map((c, i) => cell(c.label ?? c, 1, i).replace('<c ', '<c s="1" ')).join('')}</row>`;
  const body = rows.map((r, ri) => `<row r="${ri + 2}">${columns.map((c, ci) => cell(r[c.key ?? c], ri + 2, ci)).join('')}</row>`).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${header}${body}</sheetData></worksheet>`;
  const name = xml(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>'],
    ['xl/worksheets/sheet1.xml', sheet],
  ]);
}

export const downloadXlsx = (filename, columns, rows, sheet = filename) => save(toXlsx(sheet, columns, rows), `${filename}.xlsx`);

/** PDF: a print view of the table, where the browser's print dialog offers "Save as PDF" */
export function printTable(title, columns, rows, subtitle = '') {
  const w = window.open('', '_blank', 'width=1000,height=800');
  if (!w) return false;
  const esc = (s) => cellText(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  w.document.write(`<!doctype html><html><head><title>${esc(title)}</title><style>
    body{font:12px/1.4 Arial,Helvetica,sans-serif;color:#111;margin:24px} h1{font-size:18px;margin:0 0 4px} p{margin:0 0 14px;color:#555}
    table{border-collapse:collapse;width:100%} th,td{border:1px solid #ccc;padding:5px 7px;text-align:left;vertical-align:top} th{background:#f1f3f6}
    td.n{text-align:right;font-variant-numeric:tabular-nums} @page{size:A4 landscape;margin:12mm}</style></head><body>
    <h1>${esc(title)}</h1><p>${esc(subtitle)} · Generated ${esc(new Date().toLocaleString('en-IN'))}</p>
    <table><thead><tr>${columns.map((c) => `<th>${esc(c.label ?? c)}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((r) => `<tr>${columns.map((c) => { const v = r[c.key ?? c]; return `<td class="${typeof v === 'number' ? 'n' : ''}">${esc(typeof v === 'number' ? v.toLocaleString('en-IN') : v)}</td>`; }).join('')}</tr>`).join('')}
    </tbody></table><script>window.onload=()=>{window.print()}</script></body></html>`);
  w.document.close();
  return true;
}

/** A small CSV parser (quotes, commas and newlines inside quotes) for the customer import */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); // a byte-order mark from Excel
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
  const key = { name: 'name', fullname: 'name', email: 'email', emailaddress: 'email', phone: 'phone', mobile: 'phone', tags: 'tags', birthday: 'birthday', emailoptin: 'emailOptIn', marketing: 'emailOptIn' };
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [key[h] || h, (r[i] ?? '').trim()]).filter(([k]) => Object.values(key).includes(k))));
}
