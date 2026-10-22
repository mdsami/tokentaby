'use strict';
// Nous Research Hermes Agent. $HERMES_HOME/state.db (default ~/.hermes):
// sessions (id, cwd, git_branch, started_at, ended_at, parent_session_id) and
// session_model_usage — cumulative token counters per (session, model,
// billing route, task) with last_seen. Per-turn rows are not stored, so each
// import logs the growth of those counters since the last one.
// input_tokens excludes cache reads and writes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite = require('../sqlite');
const { iso } = require('./util');

const home = () => process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const dbFile = () => path.join(home(), 'state.db');
const COUNTERS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];

module.exports = {
  id: 'hermes',
  tools: { 'hermes-agent': 'Hermes Agent' },
  where: dbFile,
  available: () => fs.existsSync(dbFile()),

  list() {
    // a session's usage moves with its model-usage rows, so their last_seen is the change marker
    return sqlite
      .query(
        dbFile(),
        `select s.id, s.cwd, s.git_branch, s.started_at, s.parent_session_id,
           (select max(last_seen) from session_model_usage u where u.session_id = s.id) as seen
         from sessions s`
      )
      .map((r) => ({ key: r.id, cwd: r.cwd, branch: r.git_branch || null, parent: r.parent_session_id || null, started: iso(r.started_at), mtimeMs: (r.seen || r.started_at || 0) * 1000 }));
  },

  describe: (s) => ({ id: s.parent || s.key, agent: s.parent ? s.key : null, cwd: s.cwd, tool: 'hermes-agent', branch: s.branch, started: s.started }),

  read(s, wm) {
    const prev = (wm && wm.counters) || {};
    const counters = {};
    const records = [];
    const rows = sqlite.query(dbFile(), `select model, billing_provider, billing_base_url, billing_mode, task, ${COUNTERS.join(', ')}, last_seen from session_model_usage where session_id = ?`, [s.key]);
    for (const r of rows) {
      const key = [r.model, r.billing_provider, r.billing_base_url, r.billing_mode, r.task].join('|');
      counters[key] = COUNTERS.map((c) => r[c] || 0);
      const before = prev[key] || [0, 0, 0, 0];
      const d = counters[key].map((v, i) => Math.max(0, v - before[i]));
      if (!d.some(Boolean)) continue;
      records.push({ uid: key, ts: iso(r.last_seen), turn: key, model: r.model || 'unknown', in: d[0], out: d[1], cr: d[2], cw: d[3], agentType: s.parent ? 'subagent' : null });
    }
    return { records, prompts: [], wm: { counters } };
  },
};
