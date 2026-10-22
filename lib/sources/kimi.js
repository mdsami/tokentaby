'use strict';
// Moonshot Kimi Code (the TypeScript CLI, ~/.kimi-code). session_index.jsonl
// lists { sessionId, sessionDir, workDir }; each agent of a session appends
// records to <sessionDir>/agents/<agent>/wire.jsonl. One
// { type: "usage.record", model, usage: { inputOther, output, inputCacheRead,
// inputCacheCreation }, usageScope, time } per LLM step; `model` is an alias
// into config.toml's model table. Typed prompts are { type:
// "context.append_message", message: { role: "user", content, origin: { kind:
// "user" } } }. The log can be rewritten (protocol migration, rewinds) and a
// resumed session replays usage through the same logger with a new time, so
// usage is deduplicated by its numbers, never by offset or time.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { dir, eachLine, iso, textOf } = require('./util');

const home = () => process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');

/** alias -> provider model id, from [models.<alias>] sections of config.toml. */
function aliases() {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(path.join(home(), 'config.toml'), 'utf8');
  } catch {
    return out;
  }
  let cur = null;
  for (const line of text.split('\n')) {
    const sec = /^\s*\[\s*models\.(?:"([^"]+)"|([^\]\s]+))\s*\]/.exec(line);
    if (sec) cur = sec[1] || sec[2];
    else if (/^\s*\[/.test(line)) cur = null;
    else if (cur) {
      const m = /^\s*model\s*=\s*"([^"]+)"/.exec(line);
      if (m) out[cur] = m[1];
    }
  }
  return out;
}

module.exports = {
  id: 'kimi',
  tools: { 'kimi-code': 'Kimi Code' },
  where: () => path.join(home(), 'sessions'),
  available: () => fs.existsSync(path.join(home(), 'session_index.jsonl')),

  list() {
    const out = [];
    const seen = new Set();
    eachLine(path.join(home(), 'session_index.jsonl'), 0, (o) => {
      if (!o.sessionId || !o.sessionDir || seen.has(o.sessionId)) return;
      seen.add(o.sessionId);
      for (const a of dir(path.join(o.sessionDir, 'agents'))) {
        const file = path.join(o.sessionDir, 'agents', a.name, 'wire.jsonl');
        let st;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        out.push({ key: `${o.sessionId}-${a.name}`, session: o.sessionId, agent: a.name, cwd: o.workDir, file, mtimeMs: st.mtimeMs, size: st.size });
      }
    });
    return out;
  },

  describe: (s) => ({ id: s.session, agent: s.agent === 'main' ? null : s.agent, cwd: s.cwd, tool: 'kimi-code', branch: null, started: null }),

  read(s, wm) {
    const done = new Set((wm && wm.done) || []);
    const names = aliases();
    const records = [];
    const prompts = [];
    let turn = null;
    eachLine(s.file, 0, (o, at) => {
      if (o.type === 'usage.record' && o.usage) {
        const u = o.usage;
        const key = `${o.model}:${u.inputOther}:${u.output}:${u.inputCacheRead}:${u.inputCacheCreation}`;
        if (done.has(key)) return;
        done.add(key);
        if (!(u.inputOther || u.output || u.inputCacheRead)) return;
        records.push({
          uid: key,
          ts: iso(o.time),
          turn,
          model: names[o.model] || o.model || 'unknown',
          in: u.inputOther || 0,
          out: u.output || 0,
          cr: u.inputCacheRead || 0,
          cw: u.inputCacheCreation || 0,
          agentType: s.agent === 'main' ? null : 'subagent',
        });
      } else if (o.type === 'context.append_message' && o.message && o.message.role === 'user' && o.message.origin && o.message.origin.kind === 'user') {
        turn = o.time || at;
        if (s.agent !== 'main') return;
        const text = textOf(o.message.content);
        const key = `p:${o.time}:${text.length}`;
        if (text.trim() && !done.has(key)) {
          done.add(key);
          prompts.push({ uid: key, ts: iso(o.time), text });
        }
      }
    });
    return { records, prompts, wm: { done: [...done] } };
  },
};
