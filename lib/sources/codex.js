'use strict';
// OpenAI Codex — the desktop app and the CLI share one store:
// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl (append-only), plus
// archived_sessions/. session_meta carries cwd, git branch and the
// originator ("Codex Desktop" for the app); turn_context carries the model;
// event_msg/token_count carries cumulative token totals for the session.
// OpenAI counts cached tokens inside input_tokens and reasoning inside
// output_tokens, so input = input_tokens - cached_input_tokens.

const fs = require('fs');
const os = require('os');
const path = require('path');
const ta = require('../transcript-adapter');

const home = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

function walk(dir, out) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (d.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/** session_meta of a rollout: the first line. */
function meta(file) {
  const head = ta.readIncrement(file, 0, 256 * 1024);
  if (!head) return null;
  for (const line of head.text.split('\n')) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o && o.type === 'session_meta' && o.payload) return o.payload;
  }
  return null;
}

const toolOf = (m) => (/desktop/i.test((m && m.originator) || '') ? 'codex-app' : 'codex-cli');

module.exports = {
  id: 'codex',
  tools: { 'codex-app': 'Codex App', 'codex-cli': 'Codex CLI' },
  where: () => path.join(home(), 'sessions'),

  available: () => fs.existsSync(path.join(home(), 'sessions')) || fs.existsSync(path.join(home(), 'archived_sessions')),

  /** [{ id, file, mtimeMs }] — cwd is resolved lazily through meta(). */
  list() {
    return [...walk(path.join(home(), 'sessions'), []), ...walk(path.join(home(), 'archived_sessions'), [])].map((file) => {
      const st = fs.statSync(file);
      return { key: path.basename(file, '.jsonl'), file, mtimeMs: st.mtimeMs, size: st.size };
    });
  },

  describe(s) {
    const m = meta(s.file);
    if (!m) return null;
    return { id: m.id || s.key, cwd: m.cwd || null, tool: toolOf(m), branch: (m.git && m.git.branch) || null, started: m.timestamp || null };
  },

  /** New usage since wm: { records, prompts, wm }. */
  read(s, wm) {
    const st = { offset: 0, total: null, model: null, turn: null, ...(wm || {}) };
    const records = [];
    const prompts = [];
    for (;;) {
      const inc = ta.readIncrement(s.file, st.offset);
      if (!inc || !inc.text) break;
      if (inc.reset) Object.assign(st, { total: null, model: null, turn: null });
      let pos = inc.end - Buffer.byteLength(inc.text);
      for (const line of inc.text.split('\n')) {
        const at = pos;
        pos += Buffer.byteLength(line) + 1;
        if (!line) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        const p = o && o.payload;
        if (!p) continue;
        if (o.type === 'turn_context') {
          if (p.model) st.model = p.model;
          if (p.turn_id) st.turn = p.turn_id;
        } else if (o.type === 'event_msg' && p.type === 'task_started' && p.turn_id) {
          st.turn = p.turn_id;
        } else if (o.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string' && p.message.trim()) {
          prompts.push({ uid: at, ts: o.timestamp, text: p.message });
        } else if (o.type === 'event_msg' && p.type === 'token_count' && p.info && p.info.total_token_usage) {
          const t = p.info.total_token_usage;
          const prev = st.total;
          let u = prev ? diff(t, prev) : t;
          // a rewound or compacted total: fall back to this request's own usage
          if (!u) u = p.info.last_token_usage || null;
          st.total = t;
          if (!u || !(u.input_tokens || u.output_tokens)) continue;
          const cached = Math.min(u.cached_input_tokens || 0, u.input_tokens || 0);
          records.push({
            uid: at,
            ts: o.timestamp,
            turn: st.turn,
            model: st.model || 'unknown',
            in: (u.input_tokens || 0) - cached,
            cr: cached,
            cw: 0,
            out: u.output_tokens || 0,
          });
        }
      }
      st.offset = inc.end;
    }
    return { records, prompts, wm: st };
  },
};

/** Field-wise t - prev, or null when any field went backwards. */
function diff(t, prev) {
  const out = {};
  for (const k of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']) {
    const d = (t[k] || 0) - (prev[k] || 0);
    if (d < 0) return null;
    out[k] = d;
  }
  return out;
}
