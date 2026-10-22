'use strict';
// End to end: real hook script, simulated Claude Code payloads, a throwaway
// git repo with the real pre-commit hook, then the CLI, validator, rollup,
// OTel import and dashboard API on the result.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const fake = require('./fake-secrets');

const ROOT = path.resolve(__dirname, '..');
const COLLECT = path.join(ROOT, 'hooks', 'collect.js');
const CLI = path.join(ROOT, 'scripts', 'tokentaby.js');
const FIX = path.join(__dirname, 'fixtures');
const SESSION = 'sess-0001';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokentaby-e2e-'));
const repo = path.join(tmp, 'web-app');
const projects = path.join(tmp, 'projects', '-web-app');
const transcript = path.join(projects, `${SESSION}.jsonl`);
const env = {
  ...process.env,
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_PLUGIN_DATA: path.join(tmp, 'plugin-data'),
  GIT_CONFIG_NOSYSTEM: '1',
  HOME: tmp, // keep the developer's global git config and hooks out of the test
};
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_') || k.startsWith('TOKENTABY_')) delete env[k];
// other agents' stores resolve under HOME=tmp, i.e. empty
for (const k of ['CODEX_HOME', 'XDG_DATA_HOME', 'GEMINI_CLI_HOME', 'QWEN_HOME', 'QWEN_RUNTIME_DIR', 'COPILOT_HOME', 'KIMI_CODE_HOME', 'HERMES_HOME', 'ANTIGRAVITY_GEMINI_DIR', 'ANTIGRAVITY_STATE_DB']) delete env[k];
// the dev_id the developer chose at install (tokentaby never reads git user.email)
env.CLAUDE_PLUGIN_OPTION_DEV_ID = 'sami';

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: repo, env: { ...env, ...(opts.env || {}) }, encoding: 'utf8', input: opts.input });
  if (opts.check !== false && r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr}${r.stdout}`);
  return r;
}
const git = (...args) => sh('git', args);
const cli = (...args) => sh(process.execPath, [CLI, ...args]);
const hook = (payload, extraEnv) => sh(process.execPath, [COLLECT], { input: JSON.stringify({ session_id: SESSION, transcript_path: transcript, cwd: repo, ...payload }), env: extraEnv });
const spool = () => {
  try {
    return fs.readFileSync(path.join(repo, '.git', 'tokentaby', 'spool.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const committed = () =>
  fs
    .readFileSync(path.join(repo, '.tokentaby', 'devs', 'sami', '2026-10.ndjson'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test.before(() => {
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(projects, SESSION, 'subagents'), { recursive: true });
  // the transcript as Claude Code has written it so far (last entry still unterminated)
  fs.copyFileSync(path.join(FIX, 'main-session.jsonl'), transcript);
  for (const f of ['agent-agent01.jsonl', 'agent-agent01.meta.json']) {
    fs.copyFileSync(path.join(FIX, SESSION, 'subagents', f), path.join(projects, SESSION, 'subagents', f));
  }
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'sami@example.com');
  git('config', 'user.name', 'Sami');
  fs.writeFileSync(path.join(repo, 'app.js'), 'console.log(1);\n');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  git('checkout', '-q', '-b', 'feat/TKT-142-retry');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('collection is opt-in: an uninitialised repo is left alone', () => {
  const r = hook({ hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(path.join(repo, '.git', 'tokentaby')), false);
});

test('init creates .tokentaby/ and the pre-commit hook', () => {
  const out = cli('init', '--ci').stdout;
  assert.match(out, /tokentaby set up/);
  for (const f of ['schema-version', 'pricing.json', 'config.json', 'devs.json', 'README.md', '.gitattributes']) {
    assert.ok(fs.existsSync(path.join(repo, '.tokentaby', f)), f);
  }
  assert.ok(fs.existsSync(path.join(repo, '.github', 'workflows', 'tokentaby.yml')));
  assert.match(fs.readFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), 'utf8'), /# >>> tokentaby >>>/);
  git('add', '.tokentaby', '.github');
  git('commit', '-q', '-m', 'chore: add tokentaby');
});

test('without a chosen dev_id nothing is logged and the session says how to start', () => {
  const r = hook({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'sess-nodev' }, { CLAUDE_PLUGIN_OPTION_DEV_ID: '' });
  assert.match(JSON.parse(r.stdout).systemMessage, /not chosen your developer id/);
  hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hello', session_id: 'sess-nodev' }, { CLAUDE_PLUGIN_OPTION_DEV_ID: '' });
  hook({ hook_event_name: 'Stop', session_id: 'sess-nodev' }, { CLAUDE_PLUGIN_OPTION_DEV_ID: '' });
  assert.equal(spool().length, 0);
  assert.equal(hook({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'sess-nodev' }, { CLAUDE_PLUGIN_OPTION_DEV_ID: '' }).stdout, '', 'the reminder is at most daily');
});

test('a session is collected into the clone-local spool', () => {
  const start = hook({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' });
  assert.match(JSON.parse(start.stdout).systemMessage, /usage in this repo is logged/);
  assert.equal(hook({ hook_event_name: 'SessionStart', source: 'compact' }).stdout, '', 'the notice is shown once');

  hook({ hook_event_name: 'UserPromptSubmit', prompt: '/tokentaby:task TKT-9' });
  hook({ hook_event_name: 'UserPromptSubmit', prompt: `deploy with key ${fake.aws} please` });
  hook({ hook_event_name: 'Stop', stop_hook_active: false });
  hook({ hook_event_name: 'Stop', stop_hook_active: false }); // idempotent
  hook({ hook_event_name: 'SubagentStop', agent_id: 'agent01', agent_type: 'Explore', agent_transcript_path: path.join(projects, SESSION, 'subagents', 'agent-agent01.jsonl') });
  hook({ hook_event_name: 'PostModelSwitch', from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', source: 'command' });

  const ev = spool();
  const prompts = ev.filter((e) => e.t === 'prompt');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].text, 'deploy with key [REDACTED] please', 'secrets never reach disk');
  assert.equal(prompts[1].task, 'TKT-9', 'explicit task beats the branch ticket');
  assert.ok(ev.some((e) => e.t === 'task' && e.status === 'set' && e.task === 'TKT-9'));

  const turns = ev.filter((e) => e.t === 'turn');
  const main = turns.filter((e) => e.agent === 'main');
  const sub = turns.filter((e) => e.agent !== 'main');
  assert.deepEqual(main.map((e) => [e.model, e.req]).sort(), [['claude-opus-5-5', 2], ['claude-sonnet-5-5', 1]]);
  assert.equal(main.filter((e) => e.dur_ms > 0).length, 1, 'turn duration recorded once per batch');
  assert.ok(main.every((e) => e.task === 'TKT-9' && e.branch === 'feat/TKT-142-retry' && e.dev === 'sami'));
  assert.equal(main.find((e) => e.model === 'claude-opus-5-5').usd, 0.02562);
  assert.equal(main.find((e) => e.model === 'claude-opus-5-5').cw1h, 1000);
  assert.deepEqual(sub.map((e) => [e.agent, e.agent_type, e.model, e.req]), [['agent01', 'Explore', 'claude-haiku-5-5', 2]]);
  assert.equal(sub[0].usd, Number((0.006301 + 0.006505).toFixed(6)));
  assert.ok(ev.some((e) => e.t === 'session' && e.event === 'model' && e.model === 'claude-sonnet-5-5'));
  assert.equal(git('status', '--porcelain').stdout, '', 'the working tree stays clean during a session');
});

test('SessionEnd picks up the last message and records the end', () => {
  // Claude Code finishes writing the entry that was mid-line before
  fs.appendFileSync(transcript, '\n');
  hook({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
  const ev = spool();
  const turns = ev.filter((e) => e.t === 'turn' && e.agent === 'main');
  assert.equal(turns.reduce((s, e) => s + e.req, 0), 4, 'msg_A, msg_B, msg_C, msg_D — each exactly once');
  assert.ok(ev.some((e) => e.t === 'session' && e.event === 'end' && e.reason === 'prompt_input_exit'));
});

test('ride-along: the next normal commit carries the usage', () => {
  const queued = spool().length;
  fs.writeFileSync(path.join(repo, 'app.js'), 'console.log(2);\n');
  git('add', 'app.js');
  git('commit', '-q', '-m', 'feat: retry webhook');
  const files = git('show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n').sort();
  assert.deepEqual(files, ['.tokentaby/devs/sami/2026-10.ndjson', 'app.js']);
  assert.equal(committed().length, queued);
  assert.equal(spool().length, 0);
  assert.equal(git('status', '--porcelain').stdout, '');
});

test('the CLI reads the committed data', () => {
  const p = JSON.parse(cli('summary', '--json', '--to', '2026-10-21').stdout);
  assert.equal(p.me, 'sami');
  assert.equal(p.month.team.req, 6);
  assert.equal(p.month.topModel, 'claude-opus-5-5');
  const text = cli('summary', '--to', '2026-10-21').stdout;
  assert.match(text, /estimated API-equivalent cost/);
  const tasks = JSON.parse(cli('query', 'tasks', '--task', 'TKT-9').stdout).tasks;
  assert.equal(tasks[0].task, 'TKT-9');
  assert.ok(tasks[0].usd > 0);
  const csv = cli('export', '--kind', 'turns').stdout.trim().split('\n');
  assert.match(csv[0], /^ts,dev,session,agent,agent_type,model,in,out/);
  assert.equal(csv.length, 5);
  const inr = sh(process.execPath, [CLI, 'summary', '--to', '2026-10-21'], { env: { TOKENTABY_CURRENCY: 'INR' } }).stdout;
  assert.match(inr, /₹/);
});

test('validate passes clean data and flags foreign appends and secrets', () => {
  assert.match(cli('validate', '--base', 'main').stdout, /OK/);
  // someone else appends to sami's log
  fs.appendFileSync(path.join(repo, '.tokentaby', 'devs', 'sami', '2026-10.ndjson'), JSON.stringify({ v: 1, t: 'session', ts: '2026-10-21T12:00:00Z', dev: 'sami', session: 'x', event: 'start' }) + '\n');
  git('add', '.tokentaby');
  sh('git', ['-c', 'user.email=mallory@example.com', '-c', 'user.name=Mallory', 'commit', '-q', '--no-verify', '-m', 'edit'], {});
  const bad = sh(process.execPath, [CLI, 'validate', '--base', 'main'], { check: false });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /mallory@example\.com.*devs\/sami/);
  git('reset', '-q', '--hard', 'HEAD~1');
});

test('the pre-commit hook refuses a logged secret', () => {
  fs.appendFileSync(path.join(repo, '.git', 'tokentaby', 'spool.ndjson'), JSON.stringify({ v: 1, t: 'prompt', ts: '2026-10-21T12:00:00Z', dev: 'sami', session: 'x', hash: 'h', chars: 5, text: fake.github }) + '\n');
  fs.writeFileSync(path.join(repo, 'app.js'), 'console.log(3);\n');
  git('add', 'app.js');
  const r = sh('git', ['commit', '-q', '-m', 'oops'], { check: false });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to commit[\s\S]*github-token/);
  git('reset', '-q', '--hard', 'HEAD');
  git('clean', '-qfd');
});

test('auto-commit mode commits usage alone and leaves other staged work', () => {
  fs.writeFileSync(path.join(repo, '.tokentaby', 'config.json'), JSON.stringify({ prompt_mode: 'hash_only', sync: 'auto-commit' }));
  git('commit', '-qam', 'chore: auto-commit mode');
  fs.writeFileSync(path.join(repo, 'wip.js'), 'wip\n');
  git('add', 'wip.js');
  const s2 = { session_id: 'sess-0002', transcript_path: path.join(projects, 'sess-0002.jsonl') };
  fs.copyFileSync(path.join(FIX, 'main-session.jsonl'), s2.transcript_path);
  hook({ ...s2, hook_event_name: 'SessionStart', source: 'startup' });
  hook({ ...s2, hook_event_name: 'UserPromptSubmit', prompt: 'secret plans' });
  hook({ ...s2, hook_event_name: 'SessionEnd', reason: 'other' });
  assert.match(git('log', '-1', '--format=%s').stdout, /^chore\(usage\): sami \d{4}-\d{2}-\d{2}/);
  const files = git('show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n');
  assert.deepEqual(files, ['.tokentaby/devs/sami/2026-10.ndjson']);
  assert.match(git('diff', '--cached', '--name-only').stdout, /wip\.js/, 'the developer\'s staged work is untouched');
  const p = committed().filter((e) => e.t === 'prompt' && e.session === 'sess-0002');
  assert.equal(p.length, 1);
  assert.equal(p[0].text, undefined, 'hash_only stores no text');
  assert.ok(p[0].hash);
  git('reset', '-q', 'wip.js');
});

test('OTel import fills only what transcripts cannot show, once', () => {
  const r = JSON.parse(cli('ingest-otel', path.join(FIX, 'otel-export.jsonl'), '--json').stdout);
  assert.equal(r.records, 5);
  assert.equal(r.imported, 2, 'compaction + title calls of a hook-covered session');
  assert.equal(r.inTranscript, 1);
  assert.equal(r.otherDev, 1);
  assert.equal(r.unknownSession, 1);
  assert.deepEqual(r.events.map((e) => e.qs).sort(), ['compact', 'generate_session_title']);
  const again = JSON.parse(cli('ingest-otel', path.join(FIX, 'otel-export.jsonl'), '--json').stdout);
  assert.equal(again.imported, 0);
  assert.equal(again.duplicate, 2);
});

test('rollup squashes old months without changing totals', () => {
  const old = path.join(repo, '.tokentaby', 'devs', 'sami', '2026-07.ndjson');
  const rows = [
    { v: 1, t: 'turn', ts: '2026-07-03T10:00:00Z', dev: 'sami', session: 'o1', agent: 'main', agent_type: null, model: 'claude-opus-5-5', in: 5, out: 50, cw: 0, cr: 500, usd: 0.25, task: 'TKT-1', branch: 'main', dur_ms: 1000, req: 1 },
    { v: 1, t: 'turn', ts: '2026-07-03T11:00:00Z', dev: 'sami', session: 'o1', agent: 'main', agent_type: null, model: 'claude-opus-5-5', in: 5, out: 50, cw: 0, cr: 500, usd: 0.25, task: 'TKT-1', branch: 'main', dur_ms: 1000, req: 2 },
    { v: 1, t: 'session', ts: '2026-07-03T09:59:00Z', dev: 'sami', session: 'o1', event: 'start' },
  ];
  fs.writeFileSync(old, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const before = JSON.parse(cli('query', 'summary', '--from', '2026-07-01', '--to', '2026-07-31').stdout).totals;
  cli('rollup', '--before', '2026-09');
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(path.join(repo, '.tokentaby', 'rollups', '2026-07.ndjson')));
  const after = JSON.parse(cli('query', 'summary', '--from', '2026-07-01', '--to', '2026-07-31').stdout).totals;
  assert.equal(after.usd, before.usd);
  assert.equal(after.req, 3);
  assert.equal(after.sessions, 1);
  assert.match(cli('validate').stdout, /OK/);
});

test('backfill imports past sessions per turn, once, and skips live-tracked ones', () => {
  // a session the hooks never saw (sess-0001 and sess-0002 were tracked live above)
  const old = path.join(tmp, 'projects-old');
  fs.mkdirSync(old, { recursive: true });
  const text = fs.readFileSync(path.join(FIX, 'main-session.jsonl'), 'utf8').replaceAll('sess-0001', 'sess-old1');
  fs.writeFileSync(path.join(old, 'sess-old1.jsonl'), text.endsWith('\n') ? text : text + '\n');
  fs.copyFileSync(transcript, path.join(old, `${SESSION}.jsonl`));
  const past = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(old, 'sess-old1.jsonl'), past, past);
  const r = JSON.parse(cli('backfill', '--project-dir', old, '--json').stdout);
  assert.equal(r.sessions, 2);
  assert.equal(r.imported, 1);
  assert.equal(r.alreadyTracked, 1, 'a live-tracked session is not imported again');
  assert.equal(r.prompts, 1, 'one human prompt in the transcript');
  const ev = spool().filter((e) => e.session === 'sess-old1');
  const turns = ev.filter((e) => e.t === 'turn');
  assert.equal(turns.reduce((s, e) => s + e.req, 0), 4, 'msg_A..msg_D once each');
  assert.ok(ev.some((e) => e.t === 'session' && e.event === 'start' && e.source === 'backfill'));
  assert.ok(ev.some((e) => e.t === 'session' && e.event === 'end'));
  const again = JSON.parse(cli('backfill', '--project-dir', old, '--json').stdout);
  assert.equal(again.imported, 0);
  assert.equal(again.turnRows, 0);
});

test('snapshot is a self-contained dashboard whose in-page API answers every view', () => {
  const out = path.join(tmp, 'snap.html');
  cli('snapshot', '--out', out);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /window\.TOKENTABY_SNAPSHOT = /);
  assert.doesNotMatch(html, /<script src=/, 'no external scripts');
  // run the injected scripts as a browser would, with window as the global object
  const vm = require('vm');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const ctx = vm.createContext({});
  ctx.window = ctx;
  vm.runInContext(scripts[0], ctx);
  vm.runInContext(scripts[1], ctx);
  return Promise.all(['/api/meta', '/api/summary', '/api/pulse', '/api/devs', '/api/models', '/api/agents', '/api/tasks', '/api/prompts'].map((p) => ctx.tokentabyLocal(p, { from: '2026-10-01', to: '2026-10-31' }))).then(([meta, sum]) => {
    assert.equal(meta.me, 'sami');
    assert.ok(meta.snapshot.generated);
    assert.ok(sum.totals.usd > 0);
    const csv = ctx.tokentabyLocal.exportFile('turns', 'csv', {});
    assert.match(csv.body, /^ts,dev,session/);
    const bare = path.join(tmp, 'snap-bare.html');
    cli('snapshot', '--out', bare, '--no-prompts');
    const data = JSON.parse(/window\.TOKENTABY_SNAPSHOT = (.*?);<\/script>/s.exec(fs.readFileSync(bare, 'utf8'))[1]);
    assert.ok(data.events.filter((e) => e.t === 'prompt').every((e) => e.text === undefined));
    assert.equal(data.meta.promptMode, 'hash_only');
  });
});

test('SessionStart upgrades a pre-commit block written by an older version', () => {
  const hookFile = path.join(repo, '.git', 'hooks', 'pre-commit');
  const current = fs.readFileSync(hookFile, 'utf8');
  // the 0.1.0–0.1.2 block called the CLI in bin/
  const old = current.replace(/tt_cli=.*\n/, '').replace(/\$tt_cli/g, '$tt_root/bin/tokentaby');
  assert.notEqual(old, current);
  fs.writeFileSync(hookFile, old);
  hook({ hook_event_name: 'SessionStart', source: 'resume' });
  assert.equal(fs.readFileSync(hookFile, 'utf8'), current);
});

test('/tokentaby:help lists every slash command the plugin ships', () => {
  const out = cli('commands').stdout;
  for (const f of fs.readdirSync(path.join(ROOT, 'commands'))) {
    assert.match(out, new RegExp(`/tokentaby:${f.replace(/\.md$/, '')}\\b`), f);
  }
});

test('dashboard API serves the data on loopback', async (t) => {
  const { createServer } = require('../lib/server');
  const { findRepo } = require('../lib/git');
  const port = 40000 + Math.floor(Math.random() * 20000);
  const server = createServer({ repo: findRepo(repo), port });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return t.skip(`local port binding not permitted here (${e.code})`);
    throw e;
  }
  const get = (p, host = `127.0.0.1:${port}`) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p, headers: { Host: host } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] }));
      }).on('error', reject);
    });
  try {
    const page = await get('/');
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>tokentaby<\/title>/);
    const meta = JSON.parse((await get('/api/meta')).body);
    assert.equal(meta.me, 'sami');
    assert.deepEqual(Object.keys(meta.fx).sort(), ['EUR', 'INR', 'USD']);
    const sum = JSON.parse((await get('/api/summary?from=2026-10-01&to=2026-10-31')).body);
    assert.ok(sum.totals.usd > 0);
    for (const p of ['/api/pulse', '/api/devs', '/api/devs/sami', '/api/models', '/api/agents', '/api/tasks', '/api/prompts?q=task', '/api/export.csv?kind=devs']) {
      assert.equal((await get(p)).status, 200, p);
    }
    assert.equal((await get('/api/meta', 'evil.example:80')).status, 421, 'DNS-rebinding guard');
  } finally {
    server.close();
  }
});
