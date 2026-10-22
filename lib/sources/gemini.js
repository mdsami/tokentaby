'use strict';
// Google Gemini CLI. Sessions: <home>/.gemini/tmp/<project>/chats/
// session-<ts>-<id8>.jsonl (subagents: chats/<parent>/<id>.jsonl; older
// versions wrote one .json object). <project> is a slug whose .project_root
// file (or ~/.gemini/projects.json) names the directory; legacy dirs are
// sha256(projectRoot). Line 1 is metadata { sessionId, projectHash, kind };
// messages may be appended again when they change (keep the last copy per
// id) and { $rewindTo: id } drops a message and everything after it.
// tokens { input (incl. cached), output, cached, thoughts, tool, total }:
// thoughts and tool-use prompt tokens are billed on top of output / input.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { dir, readJson, fileEntry, textOf } = require('./util');

const runtime = () => path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');

function projectRoots() {
  const map = {};
  const reg = readJson(path.join(runtime(), 'projects.json'));
  for (const [abs, slug] of Object.entries((reg && reg.projects) || {})) map[slug] = abs;
  return map;
}

/** Final state of a session file: { meta, messages } after re-appends and rewinds. */
function load(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const o = JSON.parse(text);
    return { meta: o, messages: Array.isArray(o.messages) ? o.messages : [] };
  }
  let meta = null;
  const byId = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    if (!meta && o.sessionId && !o.type) meta = o;
    else if (o.$set && meta) Object.assign(meta, o.$set);
    else if (o.$rewindTo !== undefined) {
      let drop = false;
      for (const id of [...byId.keys()]) {
        if (id === o.$rewindTo) drop = true;
        if (drop) byId.delete(id);
      }
    } else if (o.$patch) {
      for (const [id, patch] of Object.entries(o.$patch)) if (byId.has(id)) byId.set(id, { ...byId.get(id), ...patch });
    } else if (o.id && o.type) {
      byId.set(o.id, byId.has(o.id) ? { ...byId.get(o.id), ...o } : o);
    }
  }
  return { meta: meta || {}, messages: [...byId.values()] };
}

module.exports = {
  id: 'gemini',
  tools: { 'gemini-cli': 'Gemini CLI' },
  where: () => path.join(runtime(), 'tmp'),
  available: () => fs.existsSync(path.join(runtime(), 'tmp')),

  list() {
    const out = [];
    const roots = projectRoots();
    for (const p of dir(path.join(runtime(), 'tmp'))) {
      if (!p.isDirectory()) continue;
      const pdir = path.join(runtime(), 'tmp', p.name);
      let root = roots[p.name] || null;
      try {
        root = fs.readFileSync(path.join(pdir, '.project_root'), 'utf8').trim() || root;
      } catch {
        // legacy hash dir: matched through projectHash
      }
      const chats = path.join(pdir, 'chats');
      for (const f of dir(chats)) {
        if (f.isFile() && /\.jsonl?$/.test(f.name)) out.push({ ...fileEntry(path.join(chats, f.name)), root, parent: null });
        else if (f.isDirectory()) {
          for (const g of dir(path.join(chats, f.name))) if (g.isFile() && g.name.endsWith('.jsonl')) out.push({ ...fileEntry(path.join(chats, f.name, g.name)), root, parent: f.name });
        }
      }
    }
    return out;
  },

  describe(s) {
    const { meta } = load(s.file);
    if (!meta.sessionId) return null;
    const sub = s.parent || meta.kind === 'subagent';
    return {
      id: s.parent || meta.sessionId,
      agent: sub ? meta.sessionId : null,
      cwd: s.root || (Array.isArray(meta.directories) && meta.directories[0]) || null,
      projectHash: meta.projectHash || null,
      tool: 'gemini-cli',
      branch: null,
      started: meta.startTime || null,
    };
  },

  read(s, wm) {
    const done = new Set((wm && wm.done) || []);
    const records = [];
    const prompts = [];
    let turn = null;
    for (const m of load(s.file).messages) {
      if (m.type === 'user') turn = m.id;
      if (done.has(m.id)) continue;
      if (m.type === 'user') {
        done.add(m.id);
        const text = textOf(m.content);
        if (!s.parent && text.trim()) prompts.push({ uid: m.id, ts: m.timestamp, text });
      } else if (m.type === 'gemini' && m.tokens && (m.tokens.input || m.tokens.output)) {
        done.add(m.id);
        const t = m.tokens;
        const cached = Math.min(t.cached || 0, t.input || 0);
        records.push({
          uid: m.id,
          ts: m.timestamp,
          turn,
          model: m.model || 'unknown',
          in: (t.input || 0) - cached + (t.tool || 0),
          cr: cached,
          cw: 0,
          out: (t.output || 0) + (t.thoughts || 0),
        });
      }
    }
    return { records, prompts, wm: { done: [...done] } };
  },
};
