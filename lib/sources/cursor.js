'use strict';
// Cursor keeps no reliable token counts on disk (bubble tokenCount stays 0),
// so its usage comes from the CSV the dashboard exports
// (cursor.com/dashboard → Usage → Export): Date, Kind, Model, Max Mode,
// "Input (w/ Cache Write)", "Input (w/o Cache Write)", Cache Read,
// Output Tokens, Total Tokens, Cost. The export does not say which repo a
// request came from: everything imported is logged to the repo it is
// imported into. Rows are deduplicated, so overlapping exports are safe.

const fs = require('fs');
const crypto = require('crypto');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

const int = (v) => {
  const n = parseInt(String(v || '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
};

/** Cursor's model labels to API ids: claude-4.5-sonnet-thinking -> claude-sonnet-4-5. */
function modelId(label) {
  const m = String(label || '').trim().toLowerCase().replace(/-thinking$|-max$/, '');
  const c = /^claude-(\d+)(?:\.(\d+))?-(opus|sonnet|haiku)(.*)$/.exec(m);
  if (c) return `claude-${c[3]}-${c[1]}${c[2] ? '-' + c[2] : ''}${c[4]}`;
  return m || 'unknown';
}

/** { records, rows, duplicate } from an export, skipping row hashes in `done`. */
function readCsv(file, done) {
  const [head, ...rows] = parseCsv(fs.readFileSync(file, 'utf8'));
  if (!head) throw new Error('empty CSV');
  const col = (re) => head.findIndex((h) => re.test(h.trim()));
  const c = {
    date: col(/^date$/i),
    model: col(/^model$/i),
    withCw: col(/^input \(w\/ cache write\)$/i),
    noCw: col(/^input \(w\/o cache write\)$/i),
    input: col(/^input( tokens)?$/i),
    cr: col(/^cache read/i),
    out: col(/^output( tokens)?$/i),
  };
  if (c.date < 0 || c.model < 0 || c.out < 0) throw new Error('not a Cursor usage export (needs Date, Model and Output Tokens columns)');
  const records = [];
  let duplicate = 0;
  for (const r of rows) {
    const hash = crypto.createHash('sha1').update(r.join('\u0001')).digest('hex').slice(0, 16);
    if (done.has(hash)) {
      duplicate++;
      continue;
    }
    done.add(hash);
    const ts = new Date(r[c.date]);
    if (isNaN(ts)) continue;
    const noCw = c.noCw >= 0 ? int(r[c.noCw]) : int(r[c.input]);
    const withCw = c.withCw >= 0 ? int(r[c.withCw]) : noCw;
    const rec = { uid: hash, ts: ts.toISOString(), model: modelId(r[c.model]), in: noCw, cw: Math.max(0, withCw - noCw), cr: c.cr >= 0 ? int(r[c.cr]) : 0, out: int(r[c.out]) };
    if (!(rec.in || rec.out || rec.cr || rec.cw)) continue;
    rec.turn = `${rec.ts.slice(0, 10)}`;
    records.push(rec);
  }
  return { records, rows: rows.length, duplicate };
}

module.exports = { readCsv, modelId, parseCsv };
