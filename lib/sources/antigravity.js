'use strict';
// Google Antigravity. Current builds (the app, the agy CLI) write each
// conversation as plain SQLite: ~/.gemini/antigravity{,-ide,-cli}/
// conversations/<id>.db. Every row of gen_metadata is one model call; its
// protobuf holds, under field 1: 4 = usage { 2 input (cache excluded),
// 3 output (= 9 thinking + 10 response), 4 cache write, 5 cache read,
// 11 response id }, 9.4 = start time, 19 = response model, 21 = display
// label ("Gemini 3.8 Flash (High)"). The workspace is a file:// URI inside
// trajectory_metadata_blob.
// Conversations from older builds are encrypted .pb files, so for those:
// - which conversations exist, their workspace folder and times come from the
//   editor's state.vscdb (ItemTable antigravityUnifiedStateSync.
//   trajectorySummaries: base64 protobuf; per conversation, field 1 = id and
//   field 2.1 = base64 summary with 3 = last modified, 7 = created,
//   9.1 = workspace file:// URI);
// - token usage comes from the running language server (antigravity-rpc.js),
//   one record per model response. Conversations are retried until
//   Antigravity is running for an import. Input and cache counts are separate
//   buckets (as codeburn and tokscale read them); model ids are internal
//   placeholders resolved to display names through GetAvailableModels.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { fileURLToPath } = require('url');
const sqlite = require('../sqlite');
const { iso } = require('./util');

function stateDb() {
  if (process.env.ANTIGRAVITY_STATE_DB) return process.env.ANTIGRAVITY_STATE_DB;
  const base =
    process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.platform === 'win32' ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
}

// ---------------------------------------------------------------- protobuf (just enough)

function varint(b, i) {
  let r = 0;
  let s = 0;
  for (;;) {
    if (i >= b.length) throw new Error('truncated');
    const x = b[i++];
    r += (x & 127) * 2 ** s;
    s += 7;
    if (!(x & 128)) return [r, i];
  }
}

/** [[field, value]] of one message: numbers for varints, Buffers for length-delimited. */
function fields(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    let key;
    [key, i] = varint(b, i);
    const f = Math.floor(key / 8);
    const wt = key & 7;
    if (wt === 0) {
      let v;
      [v, i] = varint(b, i);
      out.push([f, v]);
    } else if (wt === 2) {
      let len;
      [len, i] = varint(b, i);
      out.push([f, b.subarray(i, i + len)]);
      i += len;
    } else if (wt === 1) i += 8;
    else if (wt === 5) i += 4;
    else throw new Error('bad wire type');
  }
  return out;
}
const get = (fs_, n) => (fs_.find((x) => x[0] === n) || [])[1];
const str = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : null);
const varintOf = (fs_, n) => (typeof get(fs_, n) === 'number' ? get(fs_, n) : 0);

/** First file:// URI anywhere in a protobuf message (decoded, not pattern-matched). */
function findUri(buf, depth = 0) {
  let fs_;
  try {
    fs_ = fields(buf);
  } catch {
    return null;
  }
  for (const [, v] of fs_) {
    if (!Buffer.isBuffer(v)) continue;
    const s = v.toString('utf8');
    if (/^file:\/\/\/[^\x00-\x1f]+$/.test(s)) return s;
    if (depth < 6) {
      const inner = findUri(v, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

const toPath = (uri) => {
  try {
    return uri ? fileURLToPath(uri) : null;
  } catch {
    return null;
  }
};

const ROOTS = ['antigravity', 'antigravity-ide', 'antigravity-cli'];
const geminiDir = () => process.env.ANTIGRAVITY_GEMINI_DIR || path.join(os.homedir(), '.gemini');

/** Every conversation database of current builds: [{ id, file, mtimeMs }]. */
function conversationDbs() {
  const out = [];
  for (const root of ROOTS) {
    const dir = path.join(geminiDir(), root, 'conversations');
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.db')) continue;
      const file = path.join(dir, n);
      try {
        out.push({ id: n.slice(0, -3), file, mtimeMs: fs.statSync(file).mtimeMs });
      } catch {
        // removed meanwhile
      }
    }
  }
  return out;
}

function dbWorkspace(file) {
  const rows = sqlite.query(file, 'select data from trajectory_metadata_blob');
  for (const r of rows) {
    const b = Buffer.isBuffer(r.data) ? r.data : r.data instanceof Uint8Array ? Buffer.from(r.data) : null;
    const uri = b && findUri(b);
    if (uri) return toPath(uri);
  }
  return null;
}

/** Usage records of a conversation database, one per model call. */
function dbUsage(file) {
  const out = [];
  for (const r of sqlite.query(file, 'select idx, data from gen_metadata order by idx')) {
    const b = Buffer.isBuffer(r.data) ? r.data : r.data instanceof Uint8Array ? Buffer.from(r.data) : null;
    if (!b) continue;
    let m;
    try {
      m = get(fields(b), 1);
      if (!Buffer.isBuffer(m)) continue;
      m = fields(m);
    } catch {
      continue;
    }
    const u = get(m, 4);
    if (!Buffer.isBuffer(u)) continue;
    const uf = fields(u);
    const t = get(m, 9) && get(fields(get(m, 9)), 4);
    const sec = Buffer.isBuffer(t) ? get(fields(t), 1) : null;
    out.push({
      responseId: str(get(uf, 11)) || `idx-${r.idx}`,
      label: str(get(m, 21)) || str(get(m, 19)) || null,
      input: varintOf(uf, 2),
      output: varintOf(uf, 3),
      cacheWrite: varintOf(uf, 4),
      cacheRead: varintOf(uf, 5),
      thinking: varintOf(uf, 9),
      response: varintOf(uf, 10),
      ts: sec ? new Date(sec * 1000).toISOString() : null,
    });
  }
  return out;
}
const seconds = (buf) => (Buffer.isBuffer(buf) ? get(fields(buf), 1) : null);

/** [{ id, cwd, started, updated }] from the editor's trajectory summaries. */
function summaries() {
  const rows = sqlite.query(stateDb(), "select value from ItemTable where key = 'antigravityUnifiedStateSync.trajectorySummaries'");
  if (!rows.length || !rows[0].value) return [];
  const out = [];
  for (const [f, entry] of fields(Buffer.from(String(rows[0].value), 'base64'))) {
    if (f !== 1 || !Buffer.isBuffer(entry)) continue;
    try {
      const e = fields(entry);
      const id = get(e, 1);
      const wrap = get(e, 2);
      const b64 = wrap && get(fields(wrap), 1);
      if (!id || !b64) continue;
      const s = fields(Buffer.from(b64.toString(), 'base64'));
      const ws = get(s, 9);
      const uri = ws && get(fields(ws), 1);
      let cwd = null;
      try {
        cwd = uri && /^file:/.test(uri.toString()) ? fileURLToPath(uri.toString()) : null;
      } catch {
        // not a local folder
      }
      out.push({ id: id.toString(), cwd, started: seconds(get(s, 7)), updated: seconds(get(s, 3)) });
    } catch {
      // skip an entry in a format we do not know
    }
  }
  return out;
}

/**
 * [{ id, cwd, started, updated, parent }] from the conversation_summaries
 * table newer builds keep (~/.gemini/antigravity-cli/, antigravity-ide/):
 * conversation_id, workspace_uris, last_modified_time, parent_conversation_id.
 */
function summaryTables() {
  const out = [];
  for (const dir of ROOTS) {
    const file = path.join(geminiDir(), dir, 'conversation_summaries.db');
    if (!fs.existsSync(file)) continue;
    let rows;
    try {
      rows = sqlite.query(file, 'select conversation_id, workspace_uris, last_modified_time, last_user_input_time, parent_conversation_id from conversation_summaries');
    } catch {
      continue;
    }
    for (const r of rows) {
      const uri = (/file:\/\/\/[^\s"',\]]+/.exec(String(r.workspace_uris || '')) || [])[0];
      let cwd = null;
      try {
        cwd = uri ? fileURLToPath(decodeURI(uri).replace(/%/g, '%25')) : null;
      } catch {
        // not a local folder
      }
      const t = (v) => (v ? Date.parse(v) / 1000 || null : null);
      out.push({ id: r.conversation_id, cwd, started: null, updated: t(r.last_modified_time) || t(r.last_user_input_time), parent: r.parent_conversation_id || null, cli: dir === 'antigravity-cli' });
    }
  }
  return out;
}

// ---------------------------------------------------------------- language server snapshot

let snapshot;
function usageSnapshot() {
  if (snapshot) return snapshot;
  if (process.env.TOKENTABY_ANTIGRAVITY_SNAPSHOT) {
    snapshot = JSON.parse(fs.readFileSync(process.env.TOKENTABY_ANTIGRAVITY_SNAPSHOT, 'utf8'));
    return snapshot;
  }
  const r = spawnSync(process.execPath, [path.join(__dirname, 'antigravity-rpc.js')], { encoding: 'utf8', timeout: 60000 });
  try {
    snapshot = JSON.parse(r.stdout);
  } catch {
    snapshot = { ok: false, error: (r.stderr || 'no answer').trim() };
  }
  return snapshot;
}

/** Antigravity's display labels to API ids: "Claude Sonnet 4.5 (Thinking)" -> claude-sonnet-4.5. */
function modelId(raw, labels) {
  const label = (labels && labels[raw]) || raw || 'unknown';
  return String(label)
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

module.exports = {
  id: 'antigravity',
  tools: { antigravity: 'Antigravity' },
  where: stateDb,
  available: () => fs.existsSync(stateDb()) || ROOTS.some((d) => fs.existsSync(path.join(geminiDir(), d, 'conversations'))),

  begin() {
    snapshot = undefined; // ask the language server again on every import run
  },

  list() {
    const byId = new Map();
    let editor = [];
    try {
      editor = summaries();
    } catch {
      // editor never opened
    }
    for (const s of [...editor, ...summaryTables()]) {
      const prev = byId.get(s.id);
      byId.set(s.id, { ...prev, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v != null)) });
    }
    const out = [...byId.values()].map((s) => ({
      key: s.id,
      cwd: s.cwd || null,
      parent: s.parent || null,
      started: s.started ? new Date(s.started * 1000).toISOString() : null,
      mtimeMs: (s.updated || s.started || 0) * 1000,
    }));
    // a conversation database is the better source: readable without the app running
    for (const d of conversationDbs()) {
      const s = out.find((x) => x.key === d.id);
      if (s) Object.assign(s, { file: d.file, mtimeMs: Math.max(s.mtimeMs, d.mtimeMs) });
      else out.push({ key: d.id, cwd: null, parent: null, started: null, file: d.file, mtimeMs: d.mtimeMs });
    }
    return out;
  },

  describe: (s) => ({ id: s.parent || s.key, agent: s.parent ? s.key : null, cwd: s.cwd || (s.file ? dbWorkspace(s.file) : null), tool: 'antigravity', branch: null, started: s.started }),

  read(s, wm) {
    const done = new Set((wm && wm.done) || []);
    if (s.file) {
      const records = [];
      for (const u of dbUsage(s.file)) {
        if (done.has(u.responseId)) continue;
        done.add(u.responseId);
        const out = u.response + u.thinking || u.output;
        if (!(u.input || out || u.cacheRead)) continue;
        records.push({ uid: u.responseId, ts: u.ts || s.started, turn: u.responseId, model: modelId(u.label), in: u.input, out, cr: u.cacheRead, cw: u.cacheWrite });
      }
      return { records, prompts: [], wm: { done: [...done] } };
    }
    const snap = usageSnapshot();
    if (!snap.ok) return { records: [], prompts: [], wm: { done: [...done] }, retry: snap.error || true };
    const c = snap.cascades && snap.cascades[s.key];
    if (!c) return { records: [], prompts: [], wm: { done: [...done] }, retry: 'conversation not loaded by the language server' };
    const records = [];
    for (const u of c.usage) {
      const key = u.responseId || `${u.ts}:${u.input}:${u.output}:${u.cacheRead}`;
      if (done.has(key)) continue;
      done.add(key);
      // billed output is the response plus thinking; outputTokens is their total when the split is missing
      const out = u.response + u.thinking || u.output;
      if (!(u.input || out || u.cacheRead)) continue;
      records.push({ uid: key, ts: iso(u.ts) || s.started, turn: key, model: modelId(u.model, snap.models), in: u.input, out, cr: u.cacheRead, cw: u.cacheWrite });
    }
    return { records, prompts: [], wm: { done: [...done] } };
  },
};
