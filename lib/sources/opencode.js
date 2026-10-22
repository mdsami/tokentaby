'use strict';
// OpenCode (sst/opencode). Current versions keep everything in
// $XDG_DATA_HOME/opencode/opencode.db: session (id, parent_id, directory,
// time_updated) and message (id, session_id, data JSON). Older versions wrote
// storage/session/<project>/<id>.json and storage/message/<session>/<id>.json.
// An assistant message's data holds modelID, providerID, cost, agent/mode,
// time.completed and tokens { input, output, reasoning, cache { read, write } };
// input excludes cache reads and writes. Child sessions (parent_id) are
// subagents (the task tool) and are logged under their parent session.

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite = require('../sqlite');

const dataHome = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode');
const dbFile = () => path.join(dataHome(), 'opencode.db');
const storage = () => path.join(dataHome(), 'storage');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function dir(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

/** Every session as { key, cwd, parent, mtimeMs, kind, file? }. */
function sessions() {
  const out = [];
  if (fs.existsSync(dbFile())) {
    for (const r of sqlite.query(dbFile(), 'select id, parent_id, directory, time_created, time_updated from session')) {
      out.push({ key: r.id, cwd: r.directory, parent: r.parent_id || null, started: new Date(r.time_created).toISOString(), mtimeMs: r.time_updated, kind: 'db' });
    }
  }
  for (const project of dir(path.join(storage(), 'session'))) {
    for (const name of dir(path.join(storage(), 'session', project))) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(storage(), 'session', project, name);
      const s = readJson(file);
      if (!s || !s.id || out.some((o) => o.key === s.id)) continue;
      const t = s.time || {};
      out.push({ key: s.id, cwd: s.directory || null, parent: s.parentID || null, started: t.created ? new Date(t.created).toISOString() : null, mtimeMs: t.updated || fs.statSync(file).mtimeMs, kind: 'files' });
    }
  }
  return out;
}

function messages(s) {
  if (s.kind === 'db') {
    return sqlite.query(dbFile(), 'select id, time_created, data from message where session_id = ? order by time_created, id', [s.key]).map((r) => {
      let d = {};
      try {
        d = JSON.parse(r.data);
      } catch {
        // skip a corrupt row
      }
      return { id: r.id, created: r.time_created, ...d };
    });
  }
  const mdir = path.join(storage(), 'message', s.key);
  return dir(mdir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => readJson(path.join(mdir, n)))
    .filter(Boolean)
    .map((m) => ({ ...m, created: (m.time && m.time.created) || 0 }))
    .sort((a, b) => a.created - b.created);
}

/** Text of a user message (its text parts). */
function userText(s, msgId) {
  let parts;
  if (s.kind === 'db') {
    parts = sqlite.query(dbFile(), 'select data from part where message_id = ? order by id', [msgId]).map((r) => {
      try {
        return JSON.parse(r.data);
      } catch {
        return null;
      }
    });
  } else {
    const pdir = path.join(storage(), 'part', msgId);
    parts = dir(pdir).sort().map((n) => readJson(path.join(pdir, n)));
  }
  return parts
    .filter((p) => p && p.type === 'text' && !p.synthetic && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

module.exports = {
  id: 'opencode',
  tools: { opencode: 'OpenCode' },
  where: () => (fs.existsSync(dbFile()) ? dbFile() : storage()),

  available: () => fs.existsSync(dbFile()) || fs.existsSync(storage()),

  list: () => sessions(),

  describe: (s) => ({ id: s.parent || s.key, agent: s.parent ? s.key : null, cwd: s.cwd, tool: 'opencode', branch: null, started: s.started }),

  read(s, wm) {
    const done = new Set((wm && wm.done) || []);
    const records = [];
    const prompts = [];
    for (const m of messages(s)) {
      if (!m.id || done.has(m.id)) continue;
      if (m.role === 'user') {
        done.add(m.id);
        if (s.parent) continue; // a subagent's "prompt" is the parent agent's instruction
        const text = userText(s, m.id);
        if (text.trim()) prompts.push({ uid: m.id, ts: new Date(m.created).toISOString(), text });
      } else if (m.role === 'assistant') {
        // only finished messages: their token counts are final
        if (!m.time || !m.time.completed) continue;
        done.add(m.id);
        const t = m.tokens || {};
        const c = t.cache || {};
        if (!(t.input || t.output || c.read || c.write)) continue;
        records.push({
          uid: m.id,
          ts: new Date(m.time.created || m.created).toISOString(),
          turn: m.parentID || m.id,
          model: m.modelID || 'unknown',
          provider: m.providerID || null,
          agentType: s.parent ? m.agent || m.mode || 'subagent' : null,
          in: t.input || 0,
          out: t.output || 0,
          cr: c.read || 0,
          cw: c.write || 0,
          usd: typeof m.cost === 'number' && m.cost > 0 ? m.cost : null,
        });
      }
    }
    return { records, prompts, wm: { done: [...done] } };
  },
};
