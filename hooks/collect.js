#!/usr/bin/env node
'use strict';
// Single entry point for every tokentaby hook: reads the hook payload from
// stdin and dispatches on hook_event_name.
//
// It must never get in Claude Code's way: every error is swallowed (and
// logged when TOKENTABY_DEBUG=1), the exit code is always 0, and nothing is
// written to stdout except SessionStart's one-time JSON notice — stdout of
// UserPromptSubmit/SessionStart hooks would otherwise land in Claude's context.
// Repos without .tokentaby/ are left alone: collection is opt-in per repo.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('../lib/store');
const git = require('../lib/git');
const ta = require('../lib/transcript-adapter');
const sync = require('../lib/sync');
const { resolveConfig, userOptions } = require('../lib/config');
const { loadPricing, cost, round } = require('../lib/pricing');
const { redact } = require('../lib/secrets');
const { resolveTask, parseTaskCommand } = require('../lib/tasks');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

function pluginVersion() {
  return store.readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), {}).version || null;
}

function debug(what, data) {
  if (!process.env.TOKENTABY_DEBUG) return;
  try {
    fs.mkdirSync(store.dataDir(), { recursive: true });
    fs.appendFileSync(path.join(store.dataDir(), 'debug.ndjson'), JSON.stringify({ ts: new Date().toISOString(), what, data }) + '\n');
  } catch {
    // debugging must not break the hook either
  }
}

function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    const done = () => resolve(buf);
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      done();
    });
  });
}

// ---------------------------------------------------------------- context

/** Everything a handler needs, or null when this session is not in a tracked repo. */
function context(p) {
  const session = p.session_id;
  if (!session) return null;
  const saved = store.readSession(session);
  // the repo is pinned at SessionStart so a `cd` mid-session cannot split the data
  const repo = git.findRepo(saved.repoRoot || p.cwd || process.cwd());
  if (!repo || !store.isInitialized(repo.root)) return null;
  const state = store.readState(repo);
  const cfg = resolveConfig(repo.root, state.options);
  // inside a hook, only the option value Claude Code passes right now counts
  const dev = store.devIdFor(userOptions());
  let pricing = null;
  return {
    p,
    session,
    saved,
    repo,
    state,
    cfg,
    dev,
    now: new Date().toISOString(),
    transcript: p.transcript_path || saved.transcript || null,
    branch: git.currentBranch(repo),
    pricing: () => pricing || (pricing = loadPricing(repo.root)),
    task(branch) {
      return resolveTask({ session: store.readSession(session), clone: state.task, branch: branch || this.branch });
    },
  };
}

// ---------------------------------------------------------------- transcripts → turn events

/**
 * Turn rows for whatever `file` gained since its watermark. One row per
 * (model, speed); the batch's wall time goes on the first row only so that
 * summing dur_ms never double counts.
 */
function processTranscript(ctx, file, key, agent, limit) {
  if (!file) return 0;
  // cheap skip without taking the lock when nothing was appended
  const pre = store.readWatermark(ctx.session, key);
  try {
    if (pre && fs.statSync(file).size === pre.offset) return 0;
  } catch {
    return 0;
  }
  const n = store.lockWatermark(ctx.session, key, () => {
    const existing = store.readWatermark(ctx.session, key);
    const wm = existing || { offset: 0, recent: {} };
    const inc = ta.readIncrement(file, wm.offset, limit);
    if (!inc) return 0;
    // a resumed/forked session's first pass must not re-count the history it was seeded with
    const s = store.readSession(ctx.session);
    const seeded = !existing && (s.source === 'resume' || s.source === 'fork') && s.started;
    const minTs = seeded ? new Date(Date.parse(s.started) - 5000).toISOString() : null;
    const batch = ta.extractMessages(ta.parseLines(inc.text), { sessionId: ctx.session, minTs });
    const recent = wm.recent || {};
    const pricing = ctx.pricing();
    const rows = ta.groupByModel(ta.diffAgainst(batch.messages, recent), (m, u, s, pt) => cost(pricing, m, u, s, pt));
    const branch = batch.branch || ctx.branch;
    const task = ctx.task(branch);
    const span = batch.first && batch.last ? Math.max(0, Date.parse(batch.last) - Date.parse(batch.first)) : 0;
    const agentType = agent.type || batch.messages.map((m) => m.agentType).find(Boolean) || null;
    const events = rows.map((r, i) => turnEvent(ctx, r, { agent: agent.id, agentType, branch, task, dur_ms: i === 0 ? span : 0 }));
    store.appendEvents(ctx.repo, events);
    const lastModel = rows.length ? rows[rows.length - 1].model : wm.lastModel || null;
    store.writeWatermark(ctx.session, key, { offset: inc.end, recent: ta.trimRecent(recent), lastModel });
    return events.length;
  });
  return n || 0;
}

function turnEvent(ctx, r, { agent, agentType, branch, task, dur_ms }) {
  const ev = {
    t: 'turn',
    ts: r.ts || ctx.now,
    dev: ctx.dev,
    session: ctx.session,
    agent,
    agent_type: agent === 'main' ? null : agentType || null,
    model: r.model,
    in: r.in,
    out: r.out,
    cw: r.cw,
    cr: r.cr,
    usd: r.unpriced ? null : round(r.usd),
    task: task || null,
    branch: branch || null,
    dur_ms,
    req: r.req,
  };
  if (r.cw1h) ev.cw1h = r.cw1h;
  if (r.effort) ev.effort = r.effort;
  if (r.speed && r.speed !== 'standard') ev.speed = r.speed;
  if (r.ws) ev.ws = r.ws;
  return ev;
}

function processMain(ctx) {
  return processTranscript(ctx, ctx.transcript, 'main', { id: 'main' });
}

/** Catch up every subagent transcript of the session (covers agents whose SubagentStop we never saw). */
function processSubagents(ctx) {
  if (!ctx.transcript) return 0;
  let n = 0;
  for (const { agentId, file } of ta.listSubagents(ctx.transcript, ctx.session)) {
    n += processTranscript(ctx, file, `agent-${agentId}`, { id: agentId, type: agentTypeFor(ctx, agentId, file) });
  }
  return n;
}

function agentTypeFor(ctx, agentId, file, hinted) {
  if (hinted) return hinted;
  const fromMeta = file ? ta.subagentType(file) : null;
  if (fromMeta) return fromMeta;
  return (store.readSession(ctx.session).agents || {})[agentId] || null;
}

// ---------------------------------------------------------------- handlers

function onSessionStart(ctx) {
  const { p, repo } = ctx;
  store.writeSession(ctx.session, { repoRoot: repo.root, transcript: ctx.transcript, started: ctx.now, source: p.source || null });
  // identity + plugin location for the git hook and the CLI (they run outside Claude)
  const dev = ctx.dev;
  const state = store.writeState(repo, { dev, plugin_root: PLUGIN_ROOT, version: pluginVersion(), options: userOptions(), data_dir: store.dataDir(), last_session: ctx.now });
  // install the git hook, or refresh a block an older plugin version wrote (no-op when current)
  debug('hook', git.installPreCommit(repo));
  const cwdRel = path.relative(repo.root, p.cwd || repo.root).split(path.sep).join('/') || '.';
  store.appendEvents(repo, [
    {
      t: 'session',
      ts: ctx.now,
      dev,
      session: ctx.session,
      event: 'start',
      source: p.source || null,
      cwd_rel: cwdRel,
      branch: ctx.branch,
      model: typeof p.model === 'string' ? p.model : (p.model && p.model.id) || null,
    },
  ]);
  if (!state.pruned || state.pruned < ctx.now.slice(0, 10)) {
    store.pruneWatermarks();
    store.writeState(repo, { pruned: ctx.now.slice(0, 10) });
  }
  if (!state.notice_shown) {
    store.writeState(repo, { notice_shown: ctx.now });
    process.stdout.write(
      JSON.stringify({
        systemMessage:
          `tokentaby: Claude Code usage in this repo is logged to .tokentaby/devs/${dev}/ ` +
          `(prompts: ${ctx.cfg.prompt_mode}, sync: ${ctx.cfg.sync}). See .tokentaby/README.md. Run /tokentaby:usage for a summary.`,
      }) + '\n'
    );
  }
}

/** Tracked repo, but no dev_id chosen yet: log nothing, say how to start (at most daily). */
function onSessionStartWithoutDev(ctx) {
  const today = ctx.now.slice(0, 10);
  const state = store.writeState(ctx.repo, { plugin_root: PLUGIN_ROOT, version: pluginVersion(), options: userOptions(), data_dir: store.dataDir(), last_session: ctx.now });
  if (state.dev_notice === today) return;
  store.writeState(ctx.repo, { dev_notice: today });
  process.stdout.write(
    JSON.stringify({
      systemMessage:
        'tokentaby: this repo tracks Claude Code usage, but you have not chosen your developer id yet, so nothing is logged. ' +
        'Set dev_id in /plugin → tokentaby (e.g. the part of your work email before @).',
    }) + '\n'
  );
}

function onPrompt(ctx) {
  const prompt = String(ctx.p.prompt || '');
  const events = [];
  const explicit = parseTaskCommand(prompt);
  if (explicit !== undefined) {
    store.writeSession(ctx.session, { task: explicit });
    events.push({ t: 'task', ts: ctx.now, dev: ctx.dev, session: ctx.session, task: explicit, status: explicit ? 'set' : 'cleared', title: null });
  }
  const clean = redact(prompt).text;
  const ev = {
    t: 'prompt',
    ts: ctx.now,
    dev: ctx.dev,
    session: ctx.session,
    task: ctx.task(),
    hash: crypto.createHash('sha1').update(clean).digest('hex').slice(0, 16),
    chars: prompt.length,
  };
  if (ctx.cfg.prompt_mode === 'full') ev.text = clean;
  else if (ctx.cfg.prompt_mode === 'truncated') ev.text = truncate(clean, ctx.cfg.truncate_chars);
  events.push(ev);
  store.appendEvents(ctx.repo, events);
}

function truncate(text, n) {
  const chars = Array.from(text);
  return chars.length > n ? chars.slice(0, n).join('') + '…' : text;
}

function onStop(ctx) {
  processMain(ctx);
  processSubagents(ctx);
}

function onSubagentStart(ctx) {
  const { agent_id: id, agent_type: type } = ctx.p;
  if (!id || !type) return;
  const s = store.readSession(ctx.session);
  store.writeSession(ctx.session, { agents: { ...(s.agents || {}), [id]: type } });
}

function onSubagentStop(ctx) {
  const { p } = ctx;
  const id = p.agent_id;
  if (!id) return processSubagents(ctx);
  const file = p.agent_transcript_path || (ctx.transcript ? ta.subagentTranscript(ctx.transcript, ctx.session, id) : null);
  processTranscript(ctx, file, `agent-${id}`, { id, type: agentTypeFor(ctx, id, file, p.agent_type) });
}

function onTask(ctx) {
  const { p } = ctx;
  const t = p.task && typeof p.task === 'object' ? p.task : {};
  const title = p.task_subject || p.subject || t.subject || t.title || null;
  const done = ctx.p.hook_event_name === 'TaskCompleted';
  if (title && !done) store.writeSession(ctx.session, { claudeTask: String(title).slice(0, 120) });
  const ev = {
    t: 'task',
    ts: ctx.now,
    dev: ctx.dev,
    session: ctx.session,
    task: ctx.task() || (title ? String(title).slice(0, 120) : null),
    status: done ? 'done' : 'created',
    title: title ? redact(String(title)).text.slice(0, 200) : null,
  };
  const tid = p.task_id || t.id;
  if (tid != null) ev.tid = String(tid);
  store.appendEvents(ctx.repo, [ev]);
}

/** Model is read per message; this marker records the switch itself (when, why, from/to). */
function onModelSwitch(ctx) {
  const { p } = ctx;
  if (!p.to_model) return;
  store.appendEvents(ctx.repo, [
    { t: 'session', ts: ctx.now, dev: ctx.dev, session: ctx.session, event: 'model', from: p.from_model || null, model: p.to_model, source: p.source || null },
  ]);
}

function onPreCompact(ctx) {
  // the transcript is about to be summarised: record everything before it is
  processMain(ctx);
  processSubagents(ctx);
}

function onSessionEnd(ctx) {
  processMain(ctx);
  processSubagents(ctx);
  // pick up what Codex, OpenCode, Gemini CLI, … logged in this repo since the last run
  debug('import', require('../lib/importer').autoImport(ctx.repo, { dev: ctx.dev }));
  store.appendEvents(ctx.repo, [
    { t: 'session', ts: ctx.now, dev: ctx.dev, session: ctx.session, event: 'end', reason: ctx.p.reason || null },
  ]);
  if (ctx.cfg.sync === 'auto-commit') debug('auto-commit', sync.commitUsage(ctx.repo, { dev: ctx.dev }));
}

const HANDLERS = {
  SessionStart: onSessionStart,
  UserPromptSubmit: onPrompt,
  Stop: onStop,
  SubagentStart: onSubagentStart,
  SubagentStop: onSubagentStop,
  TaskCreated: onTask,
  TaskCompleted: onTask,
  PostModelSwitch: onModelSwitch,
  PreCompact: onPreCompact,
  SessionEnd: onSessionEnd,
};

async function main() {
  const raw = await readStdin();
  let p;
  try {
    p = JSON.parse(raw || '{}');
  } catch {
    return;
  }
  debug('payload', p);
  const handler = HANDLERS[p.hook_event_name];
  if (!handler) return;
  const ctx = context(p);
  if (!ctx) return;
  if (ctx.dev) handler(ctx);
  else if (p.hook_event_name === 'SessionStart') onSessionStartWithoutDev(ctx);
}

if (require.main === module) {
  main()
    .catch((e) => debug('error', String((e && e.stack) || e)))
    .finally(() => process.exit(0));
}

module.exports = { HANDLERS, context, processTranscript, processSubagents, turnEvent, truncate };
