'use strict';
// Usage from other coding agents (Codex, OpenCode, Gemini CLI, …): each
// source in lib/sources/ lists the tool's local sessions and reads the token
// records added since its watermark. Sessions whose working directory lies
// inside this repo become the same turn / prompt / session events the Claude
// Code hooks write, tagged with `tool`. Safe to run any number of times.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const git = require('./git');
const { cost, round, loadPricing } = require('./pricing');
const { resolveConfig } = require('./config');
const { redact } = require('./secrets');
const { resolveTask } = require('./tasks');

const SOURCES = ['codex', 'opencode', 'gemini', 'qwen', 'copilot', 'kimi', 'hermes', 'antigravity'].filter((id) => fs.existsSync(path.join(__dirname, 'sources', `${id}.js`))).map((id) => require(`./sources/${id}`));

const { TOOLS } = require('./tools');

// a session touched this recently may still be running: the branch checked out now is probably its branch
const LIVE_MS = 12 * 3600 * 1000;

function inside(root, dir) {
  if (!dir) return false;
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const rel = path.relative(real(root), real(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** sha256 of the repo root as Gemini CLI hashes project directories (as given and resolved). */
function rootHashes(root) {
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {
    // keep the given path
  }
  return [...new Set([root, real])].map((p) => crypto.createHash('sha256').update(p).digest('hex'));
}

function truncate(text, n) {
  const chars = Array.from(text);
  return chars.length > n ? chars.slice(0, n).join('') + '…' : text;
}

/** A prompt event under the repo's prompt mode: redacted, hashed, text kept only as the mode allows. */
function promptEvent(cfg, base, { ts, text, task }) {
  const clean = redact(text).text;
  const ev = { t: 'prompt', ts, ...base, task: task || null, hash: crypto.createHash('sha1').update(clean).digest('hex').slice(0, 16), chars: text.length };
  if (cfg.prompt_mode === 'full') ev.text = clean;
  else if (cfg.prompt_mode === 'truncated') ev.text = truncate(clean, cfg.truncate_chars);
  return ev;
}

/** Records of one read -> turn rows: one per (turn, model), tokens summed, priced per record. */
function turnRows(records, pricing) {
  const groups = new Map();
  for (const r of records) {
    const k = `${r.turn != null ? r.turn : r.uid}|${r.model}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.values()].map((rs) => {
    const sum = (f) => rs.reduce((s, r) => s + (r[f] || 0), 0);
    let usd = 0;
    for (const r of rs) {
      const c = r.usd != null ? r.usd : cost(pricing, r.model, r);
      if (c == null) {
        usd = null;
        break;
      }
      usd += c;
    }
    const first = rs[0].ts;
    const last = rs[rs.length - 1].ts;
    return {
      ts: first,
      model: rs[0].model,
      agentType: rs[0].agentType || null,
      in: sum('in'),
      out: sum('out'),
      cw: sum('cw'),
      cr: sum('cr'),
      usd: usd == null ? null : round(usd),
      req: rs.length,
      dur_ms: first && last ? Math.max(0, Date.parse(last) - Date.parse(first)) : 0,
    };
  });
}

/**
 * Import every other tool's sessions for this repo.
 * ctx: { repo, dev, cfg, pricing, state }. opts: { tools: [ids], since: 'YYYY-MM-DD', dryRun }.
 * Returns { tools: { [tool]: { sessions, turnRows, prompts } }, errors: [] }.
 */
function importUsage(ctx, opts = {}) {
  const report = { tools: {}, errors: [] };
  const want = opts.tools && opts.tools.length ? new Set(opts.tools) : null;
  const now = Date.now();
  let branchNow;
  for (const src of SOURCES) {
    if (want && !want.has(src.id) && !Object.keys(src.tools).some((t) => want.has(t))) continue;
    let list;
    try {
      if (!src.available()) continue;
      if (src.begin) src.begin(); // per-run state, e.g. Antigravity's language-server answer
      list = src.list();
    } catch (e) {
      report.errors.push(`${src.id}: ${e.message}`);
      continue;
    }
    const index = store.readJson(path.join(store.dataDir(), 'sources', `${src.id}.json`), {});
    let indexDirty = false;
    for (const s of list) {
      if (opts.since && new Date(s.mtimeMs).toISOString().slice(0, 10) < opts.since) continue;
      const wmKey = `src-${src.id}-${s.key}`;
      const wm = store.readWatermark(wmKey, 'main');
      if (wm && wm.mtimeMs === s.mtimeMs && wm.size === s.size) continue;
      let desc = index[s.key];
      if (!desc) {
        try {
          desc = src.describe(s);
        } catch (e) {
          report.errors.push(`${src.id} ${s.key}: ${e.message}`);
          continue;
        }
        if (!desc) continue;
        index[s.key] = desc;
        indexDirty = true;
      }
      if (!inside(ctx.repo.root, desc.cwd) && !(desc.projectHash && rootHashes(ctx.repo.root).includes(desc.projectHash))) continue;
      if (want && !want.has(src.id) && !want.has(desc.tool)) continue;
      const t = (report.tools[desc.tool] = report.tools[desc.tool] || { sessions: 0, turnRows: 0, prompts: 0 });
      t.sessions++;
      if (opts.dryRun) continue;
      try {
        store.lockWatermark(wmKey, 'main', () => {
          const cur = store.readWatermark(wmKey, 'main');
          const res = src.read(s, cur && cur.state);
          // the data is not reachable right now (Antigravity closed): leave the watermark, try next time
          if (res.retry && !res.records.length) {
            t.waiting = (t.waiting || 0) + 1;
            return;
          }
          const live = now - s.mtimeMs < LIVE_MS;
          if (live && branchNow === undefined) branchNow = git.currentBranch(ctx.repo);
          const branch = desc.branch || (live ? branchNow : null);
          const task = resolveTask({ clone: live ? ctx.state.task : null, branch });
          const base = { dev: ctx.dev, session: desc.id, tool: desc.tool };
          const events = [];
          if (!cur && !desc.agent) {
            const first = desc.started || (res.records[0] && res.records[0].ts) || (res.prompts[0] && res.prompts[0].ts);
            if (first) events.push({ t: 'session', ts: first, ...base, event: 'start', source: 'import', branch: branch || null });
          }
          for (const p of res.prompts) events.push(promptEvent(ctx.cfg, base, { ts: p.ts, text: p.text, task }));
          for (const r of turnRows(res.records, ctx.pricing)) {
            const ev = { t: 'turn', ts: r.ts, ...base, agent: desc.agent || 'main', agent_type: desc.agent ? r.agentType || 'subagent' : null, model: r.model, in: r.in, out: r.out, cw: r.cw, cr: r.cr, usd: r.usd, task: task || null, branch: branch || null, dur_ms: r.dur_ms, req: r.req };
            events.push(ev);
            t.turnRows++;
          }
          t.prompts += res.prompts.length;
          store.appendEvents(ctx.repo, events);
          store.writeWatermark(wmKey, 'main', { mtimeMs: s.mtimeMs, size: s.size, state: res.wm });
        });
      } catch (e) {
        report.errors.push(`${src.id} ${s.key}: ${e.message}`);
      }
    }
    if (indexDirty) store.writeJsonAtomic(path.join(store.dataDir(), 'sources', `${src.id}.json`), index);
  }
  return report;
}

/**
 * Import a Cursor dashboard usage export into this repo, one turn row per day
 * and model. Returns { rows, imported, duplicate, turnRows }.
 */
function importCursorCsv(ctx, file, opts = {}) {
  const cursor = require('./sources/cursor');
  const key = 'src-cursor-csv';
  return store.lockWatermark(key, 'main', () => {
    const wm = store.readWatermark(key, 'main') || {};
    const done = new Set(wm.done || []);
    const res = cursor.readCsv(file, done);
    const report = { rows: res.rows, imported: res.records.length, duplicate: res.duplicate, turnRows: 0 };
    if (opts.dryRun) return report;
    const events = turnRows(res.records, ctx.pricing).map((r) => {
      const day = r.ts.slice(0, 10);
      return { t: 'turn', ts: r.ts, dev: ctx.dev, session: `cursor-${day}`, tool: 'cursor', agent: 'main', agent_type: null, model: r.model, in: r.in, out: r.out, cw: r.cw, cr: r.cr, usd: r.usd, task: null, branch: null, dur_ms: 0, req: r.req };
    });
    report.turnRows = events.length;
    store.appendEvents(ctx.repo, events);
    store.writeWatermark(key, 'main', { done: [...done] });
    return report;
  });
}

/**
 * Best-effort import for the automatic paths (git hook, sync, Claude Code
 * hooks, serve): never throws, does nothing without a dev id or when
 * TOKENTABY_NO_IMPORT is set. Uses the watermark folder the hooks use.
 */
function autoImport(repo, opts = {}) {
  if (process.env.TOKENTABY_NO_IMPORT) return null;
  try {
    const state = store.readState(repo);
    if (!process.env.CLAUDE_PLUGIN_DATA && state.data_dir && !opts.keepDataDir) store.setDataDir(state.data_dir);
    const cfg = resolveConfig(repo.root, state.options);
    const dev = opts.dev || store.devIdFor(cfg, state);
    if (!dev) return null;
    return importUsage({ repo, dev, cfg, state, pricing: loadPricing(repo.root) });
  } catch {
    return null;
  }
}

/** Which tools have local data on this machine: [{ id, tool names, where }]. */
function detect() {
  return SOURCES.map((s) => {
    let ok = false;
    try {
      ok = s.available();
    } catch {
      // unreadable store
    }
    return { id: s.id, tools: Object.values(s.tools), where: s.where(), available: ok };
  });
}

module.exports = { importUsage, importCursorCsv, autoImport, detect, promptEvent, turnRows, TOOLS, SOURCES };
