'use strict';
// Qwen Code. Sessions: <runtime>/projects/<sanitized cwd>/chats/<id>.jsonl,
// background subagents in .../subagents/<id>/agent-<agent>.jsonl, where
// runtime is $QWEN_RUNTIME_DIR, $QWEN_HOME or ~/.qwen. Strictly append-only
// ChatRecords carrying cwd and gitBranch; assistant records hold the raw
// usageMetadata (promptTokenCount includes cachedContentTokenCount;
// candidatesTokenCount already includes reasoning for OpenAI-style
// providers, Qwen's default). /branch copies records with forkedFrom: skipped.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { dir, eachLine, fileEntry, textOf } = require('./util');

const runtime = () => process.env.QWEN_RUNTIME_DIR || process.env.QWEN_HOME || path.join(os.homedir(), '.qwen');

module.exports = {
  id: 'qwen',
  tools: { 'qwen-code': 'Qwen Code' },
  where: () => path.join(runtime(), 'projects'),
  available: () => fs.existsSync(path.join(runtime(), 'projects')),

  list() {
    const out = [];
    for (const p of dir(path.join(runtime(), 'projects'))) {
      if (!p.isDirectory()) continue;
      const pdir = path.join(runtime(), 'projects', p.name);
      for (const f of dir(path.join(pdir, 'chats'))) if (f.isFile() && f.name.endsWith('.jsonl')) out.push({ ...fileEntry(path.join(pdir, 'chats', f.name)), parent: null });
      for (const sdir of dir(path.join(pdir, 'subagents'))) {
        if (!sdir.isDirectory()) continue;
        for (const f of dir(path.join(pdir, 'subagents', sdir.name))) {
          if (f.isFile() && f.name.endsWith('.jsonl')) out.push({ ...fileEntry(path.join(pdir, 'subagents', sdir.name, f.name), `${sdir.name}-${f.name.slice(0, -6)}`), parent: sdir.name });
        }
      }
    }
    return out;
  },

  describe(s) {
    let first = null;
    // the first record with a cwd is enough; stop reading after it
    try {
      eachLine(s.file, 0, (o) => {
        if (!first && o.cwd) {
          first = o;
          throw first;
        }
      });
    } catch (e) {
      if (e !== first) throw e;
    }
    if (!first) return null;
    return {
      id: s.parent || first.sessionId,
      agent: s.parent ? first.agentId || s.key : null,
      cwd: first.cwd,
      tool: 'qwen-code',
      branch: first.gitBranch || null,
      started: first.timestamp || null,
    };
  },

  read(s, wm) {
    const st = { offset: 0, turn: null, ...(wm || {}) };
    const records = [];
    const prompts = [];
    const res = eachLine(s.file, st.offset, (o, at) => {
      if (o.forkedFrom) return;
      if (o.type === 'user' && !o.isSidechain && !s.parent) {
        st.turn = o.promptId || o.uuid;
        const text = textOf(o.message);
        if (text.trim()) prompts.push({ uid: o.uuid || at, ts: o.timestamp, text });
      } else if (o.type === 'assistant' && o.usageMetadata) {
        const u = o.usageMetadata;
        const cached = Math.min(u.cachedContentTokenCount || 0, u.promptTokenCount || 0);
        if (!(u.promptTokenCount || u.candidatesTokenCount)) return;
        records.push({
          uid: o.uuid || at,
          ts: o.timestamp,
          turn: o.promptId || st.turn,
          model: o.model || 'unknown',
          in: (u.promptTokenCount || 0) - cached,
          cr: cached,
          cw: 0,
          out: u.candidatesTokenCount || 0,
          agentType: s.parent ? 'subagent' : null,
        });
      }
    });
    st.offset = res.offset;
    return { records, prompts, wm: st };
  },
};
