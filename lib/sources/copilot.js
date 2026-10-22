'use strict';
// GitHub Copilot CLI. Per-turn usage lives in $COPILOT_HOME/session-store.db
// (default ~/.copilot): sessions (id, cwd, repository, branch, created_at,
// updated_at) and assistant_usage_events (session_id, turn_index, model,
// input_tokens — which includes cache reads and writes — output_tokens,
// cache_read_tokens, cache_write_tokens, created_at). Prompts come from the
// session's events.jsonl (user.message) when it exists. Copilot CLI builds
// older than 1.0.8x do not write usage rows.

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite = require('../sqlite');
const { eachLine, iso, textOf } = require('./util');

const home = () => process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
const dbFile = () => path.join(home(), 'session-store.db');

module.exports = {
  id: 'copilot',
  tools: { 'copilot-cli': 'GitHub Copilot CLI' },
  where: dbFile,
  available: () => fs.existsSync(dbFile()),

  list() {
    return sqlite.query(dbFile(), 'select id, cwd, branch, created_at, updated_at from sessions').map((r) => ({
      key: r.id,
      cwd: r.cwd,
      branch: r.branch || null,
      started: iso(r.created_at),
      mtimeMs: Date.parse(iso(r.updated_at) || 0) || 0,
    }));
  },

  describe: (s) => ({ id: s.key, cwd: s.cwd, tool: 'copilot-cli', branch: s.branch, started: s.started }),

  read(s, wm) {
    const st = { rowid: 0, offset: 0, ...(wm || {}) };
    const records = [];
    const rows = sqlite.query(
      dbFile(),
      'select rowid as rid, turn_index, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at from assistant_usage_events where session_id = ? and rowid > ? order by rowid',
      [s.key, st.rowid]
    );
    for (const r of rows) {
      st.rowid = Math.max(st.rowid, r.rid);
      const cr = r.cache_read_tokens || 0;
      const cw = r.cache_write_tokens || 0;
      if (!(r.input_tokens || r.output_tokens)) continue;
      records.push({
        uid: r.rid,
        ts: iso(r.created_at),
        turn: r.turn_index,
        model: r.model || 'unknown',
        in: Math.max(0, (r.input_tokens || 0) - cr - cw),
        cr,
        cw,
        out: r.output_tokens || 0,
      });
    }
    const prompts = [];
    const events = path.join(home(), 'session-state', s.key, 'events.jsonl');
    if (fs.existsSync(events)) {
      st.offset = eachLine(events, st.offset, (o, at) => {
        if (o.type !== 'user.message' || !o.data) return;
        const text = typeof o.data.content === 'string' ? o.data.content : textOf(o.data.content || o.data.message);
        if (text && text.trim()) prompts.push({ uid: o.id || at, ts: o.timestamp, text });
      }).offset;
    }
    return { records, prompts, wm: st };
  },
};
