#!/usr/bin/env node
'use strict';
// tokentaby CLI — usage summary, dashboard server, git sync and maintenance.
// Run `tokentaby help` for the command list.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('../lib/store');
const git = require('../lib/git');
const sync = require('../lib/sync');
const validate = require('../lib/validate');
const { rollup, defaultBefore } = require('../lib/rollup');
const { resolveConfig, PROMPT_MODES, SYNC_MODES } = require('../lib/config');
const { loadPricing } = require('../lib/pricing');
const { createServer, openDataset } = require('../lib/server');
const { exportFile, EXPORT_COLUMNS } = require('../lib/api');
const { backfill } = require('../lib/backfill');
const { buildSnapshot } = require('../lib/snapshot');
const otel = require('../lib/otel');
const importer = require('../lib/importer');
const { toolName } = require('../lib/tools');

const ROOT = path.resolve(__dirname, '..');
const VERSION = store.readJson(path.join(ROOT, '.claude-plugin', 'plugin.json'), {}).version || '0.0.0';

const HELP = `tokentaby ${VERSION} — AI coding agent usage per repo, per developer
Claude Code, Codex App/CLI, OpenCode, Gemini CLI, Qwen Code, GitHub Copilot CLI.
Costs are API-equivalent ESTIMATES (the team is on subscriptions), not bills.

Usage: tokentaby <command> [options]

  summary                     today / this week / this month, you vs team (default)
  serve [--port N] [--detach] [--stop] [--no-open]
                              local dashboard on http://localhost:7331
  init [--dev ID] [--sync MODE] [--prompt-mode MODE] [--ci] [--hook-in-tracked-dir]
                              set up .tokentaby/ in this repo and the git hook
                              (--dev: your developer id when you don't use Claude Code)
  import [--tool ID,…] [--since YYYY-MM-DD] [--dry-run]
                              import this repo's sessions from Codex, OpenCode,
                              Gemini CLI, Qwen Code, Copilot CLI (also runs
                              automatically on commit, sync, summary and serve)
  import --cursor-csv FILE    import a Cursor dashboard usage export (all of it
                              counts toward this repo)
  tools                       which coding agents tokentaby finds on this machine
  task <ID> | task none       attribute usage on this branch to a task
  sync                        commit your queued usage now (manual/auto-commit modes)
  status                      what is tracked, queued and configured in this clone
  query <view> [filters]      JSON for scripts and Claude: summary periods devs
                              dev <id> models agents tasks prompts events
  export [--kind K] [--format csv|json] [--out FILE]
                              K = turns (default) prompts devs tasks models
  rollup [--before YYYY-MM] [--drop-prompts] [--dry-run]
                              squash old monthly logs into .tokentaby/rollups/
  validate [--base REF] [--head REF]
                              CI guard: schema, ownership and secrets checks
  ingest-otel <file> [--dev ID] [--all-sessions] [--dry-run]
                              import OpenTelemetry api_request events (OTLP/JSON)
                              that the transcript cannot show (compaction, …)
  backfill [--source PATH] [--project-dir DIR] [--since YYYY-MM-DD] [--dry-run]
                              import this repo's past Claude Code sessions
  snapshot [--out FILE] [--no-prompts]
                              write the dashboard as one offline HTML file
  commands                    list the /tokentaby: slash commands (what /tokentaby:help shows)
  precommit                   git pre-commit hook entry (installed by init)

Options:  --repo PATH  --json  --data-dir DIR (plugin data folder; the slash commands pass it)
Filters:  --from YYYY-MM-DD --to YYYY-MM-DD --dev ID --tool ID --model ID --task ID
          --agent TYPE --branch NAME --q TEXT --prices current
Modes:    --sync ${SYNC_MODES.join('|')}   --prompt-mode ${PROMPT_MODES.join('|')}
`;

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/i.exec(a);
    if (!m) {
      out._.push(a);
      continue;
    }
    const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (m[2] !== undefined) out[key] = m[2];
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && VALUE_FLAGS.has(key)) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

const VALUE_FLAGS = new Set(['repo', 'port', 'from', 'to', 'dev', 'tool', 'model', 'task', 'agent', 'branch', 'q', 'prices', 'sync', 'promptMode', 'kind', 'format', 'out', 'before', 'base', 'head', 'limit', 'dataDir', 'source', 'projectDir', 'since', 'report', 'cursorCsv']);

function filters(a) {
  const f = {};
  for (const k of ['from', 'to', 'dev', 'tool', 'model', 'task', 'agent', 'branch', 'q']) if (typeof a[k] === 'string') f[k] = a[k];
  if (a.prices === 'current') f.reprice = true;
  if (a.limit) f.limit = parseInt(a.limit, 10);
  return f;
}

class UsageError extends Error {}

function needRepo(a, { initialized = true } = {}) {
  const repo = git.findRepo(typeof a.repo === 'string' ? a.repo : process.cwd());
  if (!repo) throw new UsageError('not inside a git repository');
  if (initialized && !store.isInitialized(repo.root)) {
    throw new UsageError(`tokentaby is not set up in ${repo.root}\nRun /tokentaby:init in Claude Code (or tokentaby init in a terminal)`);
  }
  // share the hooks' watermarks: explicit flag, else the folder SessionStart recorded
  if (typeof a.dataDir === 'string' && a.dataDir) store.setDataDir(a.dataDir);
  else if (!process.env.CLAUDE_PLUGIN_DATA && store.readState(repo).data_dir) store.setDataDir(store.readState(repo).data_dir);
  return repo;
}

const dataset = openDataset;

// ---------------------------------------------------------------- formatting

function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function fmtMoney(usd, cfg, fx) {
  let code = (cfg && cfg.currency) || 'USD';
  if (!(fx && fx[code])) code = 'USD';
  const v = usd * (code === 'USD' ? 1 : fx[code]);
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  } catch {
    return `${v.toFixed(2)} ${code}`;
  }
}

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join('   ')).join('\n');
}

function queuedCount(repo) {
  let n = 0;
  try {
    for (const name of fs.readdirSync(store.localDir(repo))) {
      if (name.startsWith('spool.ndjson')) n += fs.readFileSync(path.join(store.localDir(repo), name), 'utf8').split('\n').filter((l) => l.trim()).length;
    }
  } catch {
    // nothing queued
  }
  return n;
}

// ---------------------------------------------------------------- commands

const commands = {
  help() {
    process.stdout.write(HELP);
  },

  /** The slash commands, read from commands/*.md so this list never drifts from what is installed. */
  commands() {
    const dir = path.join(ROOT, 'commands');
    const order = ['usage', 'init', 'backfill', 'task', 'dashboard', 'snapshot', 'sync', 'status', 'help'];
    const names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99) || (x < y ? -1 : 1));
    const lines = [`tokentaby ${VERSION} — type /tokentaby: in Claude Code to autocomplete these`, ''];
    for (const name of names) {
      const front = (/^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(path.join(dir, `${name}.md`), 'utf8')) || [])[1] || '';
      const field = (k) => ((new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(front) || [])[1] || '').replace(/^"(.*)"$/, '$1');
      lines.push(`  ${`/tokentaby:${name}`.padEnd(22)}${field('description')}`);
      if (field('argument-hint')) lines.push(`  ${''.padEnd(22)}${field('argument-hint')}`);
    }
    lines.push(
      '',
      'Or just ask: "what did TKT-142 cost?", "who used the most Opus this week?" — Claude answers from the logs.',
      `Terminal (query, export, rollup, validate, ingest-otel): node "${path.join(ROOT, 'scripts', 'tokentaby.js')}" help`,
      'Costs are estimated API-equivalent prices for subscription usage, not a bill.'
    );
    print(lines.join('\n'));
  },

  summary(a) {
    const repo = needRepo(a);
    if (!a.noImport) importer.autoImport(repo, { keepDataDir: true });
    const { ds, cfg } = dataset(repo);
    const p = ds.periods(filters(a));
    if (a.json) return print(p);
    const fx = loadPricing(repo.root).fx;
    const money = (v) => fmtMoney(v, cfg, fx);
    const rows = [['', p.me ? `you (${p.me})` : 'you', 'est. cost', 'prompts', 'team tokens', 'est. cost', 'prompts', 'sessions', 'devs']];
    for (const [label, k] of [['today', 'today'], ['this week', 'week'], ['this month', 'month']]) {
      const x = p[k];
      const mine = x.me ? [fmtTokens(x.me.tokens), money(x.me.usd), x.me.prompts] : ['—', '—', '—'];
      rows.push([label, ...mine, fmtTokens(x.team.tokens), money(x.team.usd), x.team.prompts, x.team.sessions, x.team.devs]);
    }
    const s = ds.summary({ ...filters(a) });
    const topTask = s.topTasks[0];
    const lines = [
      `tokentaby · ${path.basename(repo.root)} · estimated API-equivalent cost (subscription usage, not a bill)`,
      '',
      table(rows),
      '',
      `Top model this month: ${p.month.topModel || '—'}` + (topTask ? `   Top task: ${topTask.task} (${money(topTask.usd)})` : ''),
      s.byTool.length > 1 ? `By tool: ${s.byTool.map((t) => `${toolName(t.tool)} ${money(t.usd)}`).join(' · ')}` : null,
      `Queued, not yet committed: ${queuedCount(repo)} events · sync: ${cfg.sync} · prompts: ${cfg.prompt_mode}`,
      p.me ? 'Dashboard: /tokentaby:dashboard  (or tokentaby serve in a terminal)' : 'Your own usage is not logged until you choose a developer id: set dev_id in /plugin → tokentaby.',
    ];
    process.stdout.write(lines.filter((l) => l !== null).join('\n') + '\n');
  },

  async serve(a) {
    const repo = needRepo(a);
    if (!a.noImport && !a.stop) importer.autoImport(repo, { keepDataDir: true });
    const { cfg } = dataset(repo);
    const port = parseInt(a.port, 10) || cfg.port;
    const pidFile = path.join(store.localDir(repo), 'serve.json');
    if (a.stop) {
      const info = store.readJson(pidFile);
      if (!info) return print('No detached dashboard server is recorded for this clone.');
      try {
        process.kill(info.pid);
      } catch {
        // already gone
      }
      fs.rmSync(pidFile, { force: true });
      return print(`Stopped the dashboard server (pid ${info.pid}).`);
    }
    const url = `http://localhost:${port}`;
    if (a.detach) {
      const prev = store.readJson(pidFile);
      if (prev && isAlive(prev.pid)) return print(`Dashboard already running: ${prev.url} (pid ${prev.pid}). Stop it with: tokentaby serve --stop`);
      const args = [__filename, 'serve', '--repo', repo.root, '--port', String(port), '--report', pidFile];
      if (a.noOpen) args.push('--no-open');
      fs.mkdirSync(store.localDir(repo), { recursive: true });
      fs.rmSync(pidFile, { force: true });
      const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
      child.unref();
      // the child reports once it is listening (or why it could not)
      for (let i = 0; i < 40; i++) {
        const r = store.readJson(pidFile);
        if (r && r.error) throw new UsageError(`dashboard could not start: ${r.error}`);
        if (r && r.pid) return print(`Dashboard running at ${url} (pid ${r.pid}). Stop it with: tokentaby serve --stop`);
        await new Promise((res) => setTimeout(res, 100));
      }
      throw new UsageError(`dashboard did not report in time; try running it in the foreground: tokentaby serve --port ${port}`);
    }
    const server = createServer({ repo, port });
    const report = typeof a.report === 'string' ? a.report : null;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    }).catch((e) => {
      const msg =
        e.code === 'EADDRINUSE' ? `port ${port} is in use — try: tokentaby serve --port ${port + 1}`
        : e.code === 'EPERM' || e.code === 'EACCES' ? `not allowed to open port ${port} (${e.code}); a sandbox may block local ports — run it from your own terminal`
        : String(e.message || e);
      if (report) fs.writeFileSync(report, JSON.stringify({ error: msg }));
      throw new UsageError(msg);
    });
    if (report) fs.writeFileSync(report, JSON.stringify({ pid: process.pid, url, started: new Date().toISOString() }));
    process.stdout.write(`tokentaby dashboard: ${url}  (Ctrl+C to stop)\n`);
    if (!a.noOpen) openBrowser(url);
    await new Promise(() => {});
  },

  init(a) {
    const repo = needRepo(a, { initialized: false });
    if (a.sync && !SYNC_MODES.includes(a.sync)) throw new UsageError(`--sync must be one of ${SYNC_MODES.join(', ')}`);
    if (a.promptMode && !PROMPT_MODES.includes(a.promptMode)) throw new UsageError(`--prompt-mode must be one of ${PROMPT_MODES.join(', ')}`);
    const res = sync.init(repo, { sync: a.sync, promptMode: a.promptMode, ci: !!a.ci, allowTrackedHook: !!a.hookInTrackedDir });
    const state = store.readState(repo);
    const dev = typeof a.dev === 'string' && a.dev.trim() ? store.sanitizeDev(a.dev) : store.devIdFor(resolveConfig(repo.root, state.options), state);
    // the git hook imports other tools' usage outside any Claude session: point it at the same watermarks
    store.writeState(repo, { ...(dev ? { dev } : {}), plugin_root: ROOT, version: VERSION, ...(state.data_dir && !a.dataDir ? {} : { data_dir: store.dataDir() }) });
    if (a.json) return print(res);
    const hookMsg = {
      created: `installed ${path.relative(repo.root, res.hook.file)}`,
      inserted: `added a tokentaby block to your existing ${path.relative(repo.root, res.hook.file)}`,
      updated: `refreshed the tokentaby block in ${path.relative(repo.root, res.hook.file)}`,
      unchanged: `${path.relative(repo.root, res.hook.file)} already set up`,
      skipped: `NOT installed: core.hooksPath points at a tracked directory (${path.relative(repo.root, path.dirname(res.hook.file))}). Re-run with --hook-in-tracked-dir to add it there for everyone.`,
    }[res.hook.action];
    const lines = [
      `tokentaby set up in ${repo.root}`,
      res.created.length ? res.created.map((f) => `  + ${f}`).join('\n') : '  (all files already existed)',
      `  git hook: ${hookMsg}`,
      dev ? `  your usage is logged as "${dev}" (the dev_id you chose)` : '  you have not chosen a developer id yet: set dev_id in /plugin → tokentaby (or run tokentaby init --dev <id>) to start logging',
      '',
      'Import your past sessions in this repo: /tokentaby:backfill',
      'Next: commit .tokentaby/ so the whole team starts tracking:',
      '  git add .tokentaby' + (a.ci ? ' .github/workflows/tokentaby.yml' : '') + ' && git commit -m "chore: add tokentaby usage tracking"',
    ];
    print(lines.join('\n'));
  },

  task(a) {
    const repo = needRepo(a);
    const id = a._[1];
    if (!id) {
      const t = store.readState(repo).task;
      return print(t && t.id ? `Current task: ${t.id} (on branch ${t.branch || 'any'})` : 'No explicit task set; the ticket id in the branch name is used when present.');
    }
    const branch = git.currentBranch(repo);
    const clear = /^(none|clear|off|-)$/i.test(id);
    store.writeState(repo, { task: clear ? null : { id: id.slice(0, 120), branch, ts: new Date().toISOString() } });
    print(clear ? 'Task cleared — falling back to the ticket id in the branch name.' : `Usage on branch ${branch || '(detached)'} is now attributed to ${id}.`);
  },

  sync(a) {
    const repo = needRepo(a);
    const r = sync.commitUsage(repo);
    if (a.json) return print(r);
    print(r.committed ? `Committed usage: ${r.message}\n  ${r.files.join('\n  ')}\n(not pushed — it goes up with your next git push)` : `Nothing committed: ${r.reason}`);
    if (!r.committed && r.hits) process.exitCode = 1;
  },


  status(a) {
    const repo = needRepo(a, { initialized: false });
    const initialized = store.isInitialized(repo.root);
    const state = store.readState(repo);
    const cfg = resolveConfig(repo.root, state.options);
    const info = {
      repo: repo.root,
      initialized,
      dev: store.devIdFor(cfg, state),
      prompt_mode: cfg.prompt_mode,
      sync: cfg.sync,
      queued_events: queuedCount(repo),
      pre_commit_hook: git.hasPreCommit(repo),
      plugin_root: state.plugin_root || null,
      plugin_version: state.version || null,
      last_session: state.last_session || null,
      task: state.task || null,
      data_dir: store.dataDir(),
    };
    if (a.json) return print(info);
    print(Object.entries(info).map(([k, v]) => `${k.padEnd(20)} ${v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'));
  },

  query(a) {
    const repo = needRepo(a);
    const { ds } = dataset(repo);
    const f = filters(a);
    const view = a._[1] || 'summary';
    const views = {
      summary: () => ds.summary(f),
      periods: () => ds.periods(f),
      devs: () => ds.devs(f),
      dev: () => {
        if (!a._[2]) throw new UsageError('usage: tokentaby query dev <id>');
        return ds.devDetail(a._[2], f);
      },
      models: () => ({ models: ds.models(f), series: ds.modelSeries(f) }),
      agents: () => ds.agents(f),
      tasks: () => ds.tasks(f),
      prompts: () => ds.promptLog(f),
      events: () => store.readAllEvents(repo),
    };
    if (!views[view]) throw new UsageError(`unknown view "${view}" — one of: ${Object.keys(views).join(', ')}`);
    print(views[view]());
  },

  export(a) {
    const repo = needRepo(a);
    const { ds } = dataset(repo);
    const kind = a.kind || 'turns';
    if (!EXPORT_COLUMNS[kind]) throw new UsageError(`--kind must be one of ${Object.keys(EXPORT_COLUMNS).join(', ')}`);
    const file = exportFile(ds, store.readAllEvents(repo), kind, a.format === 'json' ? 'json' : 'csv', filters(a));
    if (typeof a.out === 'string') {
      fs.writeFileSync(a.out, file.body);
      return print(`Wrote ${kind} to ${a.out}`);
    }
    process.stdout.write(file.body.endsWith('\n') ? file.body : file.body + '\n');
  },

  rollup(a) {
    const repo = needRepo(a);
    const before = typeof a.before === 'string' ? a.before : defaultBefore();
    if (!/^\d{4}-\d{2}$/.test(before)) throw new UsageError('--before must be YYYY-MM');
    const r = rollup(repo, { before, dropPrompts: !!a.dropPrompts, dryRun: !!a.dryRun });
    if (a.json) return print(r);
    const months = Object.entries(r.months);
    if (!months.length) return print(`Nothing to roll up before ${before}.`);
    const lines = months.map(([m, x]) => `  ${m}: ${x.files} dev files, ${x.events} events -> ${x.rows} rows`);
    print(
      `${a.dryRun ? 'Would roll up' : 'Rolled up'} months before ${before}:\n${lines.join('\n')}` +
        (a.dryRun ? '' : `\nCommit .tokentaby/ to share it (git add -A .tokentaby && git commit -m "chore(usage): rollup before ${before}").`)
    );
  },

  validate(a) {
    const repo = needRepo(a);
    const tree = validate.validateTree(repo.root);
    let owner = [];
    if (typeof a.base === 'string') owner = validate.ownershipErrors(repo.root, a.base, typeof a.head === 'string' ? a.head : 'HEAD');
    const ok = !tree.errors.length && !owner.length;
    if (a.json) {
      print({ ok, ...tree, ownership: owner });
    } else {
      const out = [`tokentaby validate: ${tree.files} files, ${tree.lines} lines`];
      for (const e of tree.errors.slice(0, 200)) out.push(`  ${e.file}:${e.line}: ${e.msg}`);
      if (tree.errors.length > 200) out.push(`  … ${tree.errors.length - 200} more`);
      for (const e of owner) out.push(`  ${e.commit} (${e.email}) ${e.file}: ${e.msg}`);
      out.push(ok ? 'OK' : `FAILED: ${tree.errors.length} schema/secret problems, ${owner.length} ownership problems`);
      print(out.join('\n'));
    }
    if (!ok) process.exitCode = 1;
  },

  'ingest-otel'(a) {
    const repo = needRepo(a);
    const file = a._[1];
    if (!file) throw new UsageError('usage: tokentaby ingest-otel <otlp-export.json> [--dev ID] [--all-sessions] [--dry-run]');
    const { ds } = dataset(repo);
    const dev = typeof a.dev === 'string' ? store.sanitizeDev(a.dev) : ds.me;
    if (!dev) throw new UsageError('no developer id: pass --dev ID or set dev_id in /plugin → tokentaby');
    const r = otel.ingest(repo, file, { dev, allSessions: !!a.allSessions, dryRun: !!a.dryRun });
    if (a.json) return print(r);
    print(
      `${a.dryRun ? 'Would import' : 'Imported'} ${r.imported} of ${r.records} api_request records as ${r.rows} turn rows for ${dev}.\n` +
        `Skipped: ${r.inTranscript} already in transcripts, ${r.duplicate} imported before, ${r.unknownSession} from sessions outside this repo` +
        `${r.unknownSession ? ' (--all-sessions to include)' : ''}, ${r.otherDev} from other developers.`
    );
  },

  import(a) {
    const repo = needRepo(a);
    if (a.since && !/^\d{4}-\d{2}-\d{2}$/.test(a.since)) throw new UsageError('--since must be YYYY-MM-DD');
    const state = store.readState(repo);
    const cfg = resolveConfig(repo.root, state.options);
    const dev = typeof a.dev === 'string' ? store.sanitizeDev(a.dev) : store.devIdFor(cfg, state);
    if (!dev) throw new UsageError('no developer id: run tokentaby init --dev <id>, set dev_id in /plugin → tokentaby, or pass --dev ID');
    if (typeof a.cursorCsv === 'string') {
      const r = importer.importCursorCsv({ repo, dev, cfg, state, pricing: loadPricing(repo.root) }, a.cursorCsv, { dryRun: !!a.dryRun });
      if (a.json) return print(r);
      return print(
        `${a.dryRun ? 'Would import' : 'Imported'} ${r.imported} of ${r.rows} Cursor requests for ${dev}` +
          (a.dryRun ? '' : ` as ${r.turnRows} turn rows (one per day and model)`) +
          `${r.duplicate ? `; ${r.duplicate} already imported` : ''}.\nThe export has no repo per request: all of it is logged to ${path.basename(repo.root)}.`
      );
    }
    const tools = typeof a.tool === 'string' ? a.tool.split(',').map((x) => x.trim()).filter(Boolean) : null;
    const r = importer.importUsage({ repo, dev, cfg, state, pricing: loadPricing(repo.root) }, { tools, since: a.since, dryRun: !!a.dryRun });
    if (a.json) return print(r);
    const rows = Object.entries(r.tools);
    const lines = rows.length
      ? rows.map(([t, x]) => `  ${toolName(t).padEnd(20)} ${x.sessions} session${x.sessions === 1 ? '' : 's'}` + (a.dryRun ? '' : ` · ${x.turnRows} turn rows · ${x.prompts} prompts`))
      : ['  nothing new from other tools in this repo'];
    print(
      [`${a.dryRun ? 'Would import' : 'Imported'} for ${dev} in ${repo.root}:`, ...lines, ...r.errors.map((e) => `  ! ${e}`)].join('\n') +
        (a.dryRun || !rows.length ? '' : '\nThe events are queued; they ship with your next commit (or tokentaby sync).')
    );
  },

  tools(a) {
    const found = importer.detect();
    if (a.json) return print(found);
    print(
      [
        'Coding agents tokentaby can log, and whether their data is on this machine:',
        `  ${'Claude Code'.padEnd(34)} live, through the plugin's hooks`,
        ...found.map((t) => `  ${t.tools.join(' / ').padEnd(34)} ${t.available ? 'found' : 'not found'}  ${t.where}`),
        '',
        'Run tokentaby import --dry-run in a repo to see which sessions belong to it.',
      ].join('\n')
    );
  },

  backfill(a) {
    const repo = needRepo(a);
    if (a.since && !/^\d{4}-\d{2}-\d{2}$/.test(a.since)) throw new UsageError('--since must be YYYY-MM-DD');
    const r = backfill(repo, {
      source: typeof a.source === 'string' ? a.source : undefined,
      dir: typeof a.projectDir === 'string' ? a.projectDir : undefined,
      since: a.since,
      dryRun: !!a.dryRun,
    });
    if (a.json) return print(r);
    print(
      `${a.dryRun ? 'Would import' : 'Imported'} ${r.imported} of ${r.sessions} sessions from ${r.dir}` +
        (a.dryRun ? '' : ` (${r.turnRows} turn rows, ${r.prompts} prompts)`) +
        `.\n${r.alreadyTracked} already tracked${r.skipped ? `, ${r.skipped} older than --since` : ''}.` +
        (a.dryRun ? '' : '\nThe events are queued; they ship with your next commit (or /tokentaby:sync). Run tokentaby summary to see them.')
    );
  },

  snapshot(a) {
    const repo = needRepo(a);
    // default outside the repo: a snapshot holds logged prompts and must not be committed by accident
    const out = typeof a.out === 'string' ? a.out : path.join(require('os').tmpdir(), `tokentaby-${path.basename(repo.root)}-${new Date().toISOString().slice(0, 10)}.html`);
    const snap = buildSnapshot(repo, { noPrompts: !!a.noPrompts });
    fs.writeFileSync(out, snap.html);
    print(`Wrote ${out} (${snap.events} events, ${(snap.html.length / 1024).toFixed(0)} KB). Open it in any browser; no server needed.` + (a.noPrompts ? '\nPrompt text removed (hashes only).' : '\nIt contains the logged prompts: share it like the repo itself, or use --no-prompts.'));
  },

  precommit() {
    process.exitCode = sync.precommit(process.cwd());
  },

};

// ---------------------------------------------------------------- helpers

function print(v) {
  process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '\n');
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // headless machine: the URL is printed anyway
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0] || 'summary';
  if (a.help || cmd === '--help' || cmd === '-h') return commands.help();
  if (a.version || cmd === '--version') return print(VERSION);
  if (!commands[cmd]) throw new UsageError(`unknown command "${cmd}"\n\n${HELP}`);
  await commands[cmd](a);
}

main().catch((e) => {
  process.stderr.write(`tokentaby: ${e instanceof UsageError ? e.message : (e && e.stack) || e}\n`);
  process.exitCode = e instanceof UsageError ? 2 : 1;
});
