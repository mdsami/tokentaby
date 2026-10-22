'use strict';
// Read-only SQLite queries without dependencies: Node's built-in node:sqlite
// (22.5+), else the sqlite3 command-line tool (preinstalled on macOS).

const { spawnSync } = require('child_process');

let builtin;
function loadBuiltin() {
  if (builtin !== undefined) return builtin;
  // node:sqlite prints an ExperimentalWarning on load; keep the CLI's output clean
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (/sqlite/i.test(String(w && w.message ? w.message : w)) ? undefined : emit.call(process, w, ...rest));
  try {
    builtin = require('node:sqlite');
  } catch {
    builtin = null;
  } finally {
    process.emitWarning = emit;
  }
  return builtin;
}

/** Rows of `sql` (with ? params) against `file`, opened read-only. Throws when no engine is available. */
function query(file, sql, params = []) {
  const mod = loadBuiltin();
  if (mod && mod.DatabaseSync) {
    const db = new mod.DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare(sql).all(...params);
    } finally {
      db.close();
    }
  }
  const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  let i = 0;
  const text = sql.replace(/\?/g, () => lit(params[i++]));
  const r = spawnSync('sqlite3', ['-readonly', '-json', file, text], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error('reading SQLite needs Node 22.5+ or the sqlite3 command');
  if (r.status !== 0) throw new Error(`sqlite3: ${(r.stderr || '').trim()}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : [];
}

module.exports = { query };
