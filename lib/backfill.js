'use strict';
// Backfill: import a repo's past Claude Code sessions from
// ~/.claude/projects/<slug>/ so the dashboard has history from day one.
// Turns go through the live hooks' own processing and share their
// watermarks, so a session is counted once whether it was backfilled,
// tracked live, or both. Prompts and session markers are only added for
// sessions the hooks never saw.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const ta = require('./transcript-adapter');
const { redact } = require('./secrets');
const { resolveTask } = require('./tasks');

/** Claude Code's folder name for a working directory: every non-alphanumeric becomes "-". */
function projectSlug(dir) {
  return path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-');
}

function projectsRoot() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

/** Session events, prompts included, rebuilt from a transcript the hooks never processed. */
function sessionEvents(ctx, entries, file) {
  const prompts = ta.extractPrompts(entries, { sessionId: ctx.session });
  const stamps = entries.map((e) => e && e.timestamp).filter((t) => typeof t === 'string').sort();
  if (!stamps.length) return [];
  const firstBranch = entries.map((e) => e && e.gitBranch).find((b) => b && b !== 'HEAD') || null;
  const firstModel = (entries.find((e) => e && e.type === 'assistant' && e.message && e.message.model && e.message.model !== '<synthetic>') || { message: {} }).message.model || null;
  const base = { dev: ctx.dev, session: ctx.session };
  const events = [{ t: 'session', ts: stamps[0], ...base, event: 'start', source: 'backfill', cwd_rel: '.', branch: firstBranch, model: firstModel }];
  for (const p of prompts) {
    const clean = redact(p.text).text;
    const ev = {
      t: 'prompt',
      ts: p.ts,
      ...base,
      task: resolveTask({ branch: p.branch }),
      hash: crypto.createHash('sha1').update(clean).digest('hex').slice(0, 16),
      chars: p.text.length,
    };
    if (ctx.cfg.prompt_mode === 'full') ev.text = clean;
    else if (ctx.cfg.prompt_mode === 'truncated') ev.text = truncate(clean, ctx.cfg.truncate_chars);
    events.push(ev);
  }
  // a transcript touched in the last half hour may belong to a session still running
  if (Date.now() - fs.statSync(file).mtimeMs > 30 * 60000) {
    events.push({ t: 'session', ts: stamps[stamps.length - 1], ...base, event: 'end', reason: 'backfill' });
  }
  return events;
}

function truncate(text, n) {
  const chars = Array.from(text);
  return chars.length > n ? chars.slice(0, n).join('') + '…' : text;
}

/**
 * Import every session transcript of `source` (default: this repo's path).
 * opts: { source, dir, since: 'YYYY-MM-DD', dryRun }.
 * Returns { dir, sessions, imported, alreadyTracked, skipped, turnRows, prompts }.
 */
function backfill(repo, opts = {}) {
  const collect = require('../hooks/collect');
  const dir = opts.dir || path.join(projectsRoot(), projectSlug(opts.source || repo.root));
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort();
  } catch {
    throw new Error(`no Claude Code transcripts found in ${dir}`);
  }
  const report = { dir, sessions: names.length, imported: 0, alreadyTracked: 0, skipped: 0, turnRows: 0, prompts: 0 };
  for (const name of names) {
    const session = name.slice(0, -'.jsonl'.length);
    const file = path.join(dir, name);
    if (opts.since && new Date(fs.statSync(file).mtimeMs).toISOString().slice(0, 10) < opts.since) {
      report.skipped++;
      continue;
    }
    const ctx = collect.context({ session_id: session, transcript_path: file, cwd: repo.root });
    if (!ctx) throw new Error('tokentaby is not set up in this repo — run tokentaby init first');
    // slash commands get no plugin options: use the id SessionStart (or init --dev) saved for this clone
    ctx.dev = ctx.dev || store.devIdFor(ctx.cfg, ctx.state);
    if (!ctx.dev) throw new Error('choose your developer id first: set dev_id in /plugin → tokentaby (or TOKENTABY_DEV_ID in a terminal)');
    const seen = store.readSession(session);
    const fresh = !store.readWatermark(session, 'main') && !seen.started && !seen.backfilled;
    if (opts.dryRun) {
      if (fresh) report.imported++;
      else report.alreadyTracked++;
      continue;
    }
    if (fresh) {
      const events = sessionEvents(ctx, ta.parseLines((ta.readIncrement(file, 0) || { text: '' }).text), file);
      store.appendEvents(repo, events);
      report.prompts += events.filter((e) => e.t === 'prompt').length;
      store.writeSession(session, { repoRoot: repo.root, transcript: file, backfilled: new Date().toISOString() });
      report.imported++;
    } else {
      report.alreadyTracked++;
    }
    // turns: cut at each human prompt like the live Stop hook, resuming from the
    // shared watermark so a tracked session only adds what was missed
    for (const at of ta.promptOffsets(file)) report.turnRows += collect.processTranscript(ctx, file, 'main', { id: 'main' }, at);
    report.turnRows += collect.processTranscript(ctx, file, 'main', { id: 'main' }) + collect.processSubagents(ctx);
  }
  return report;
}

module.exports = { backfill, projectSlug, projectsRoot };
