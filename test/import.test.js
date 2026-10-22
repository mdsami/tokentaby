'use strict';
// Other coding agents: each reader against a fixture in the tool's real
// on-disk format, then the importer end to end (repo matching, token maths,
// prompts, idempotency) and the tool dimension in the aggregates.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokentaby-import-'));
const repoDir = path.join(tmp, 'web-app');
const elsewhere = path.join(tmp, 'other-project');
for (const [k, v] of Object.entries({ CODEX_HOME: 'codex', XDG_DATA_HOME: 'xdg', GEMINI_CLI_HOME: 'gemini-home', QWEN_HOME: 'qwen', COPILOT_HOME: 'copilot', KIMI_CODE_HOME: 'kimi', HERMES_HOME: 'hermes', ANTIGRAVITY_GEMINI_DIR: 'gemini-ag', ANTIGRAVITY_STATE_DB: 'antigravity-state.vscdb' })) process.env[k] = path.join(tmp, v);
delete process.env.QWEN_RUNTIME_DIR;

const store = require('../lib/store');
const git = require('../lib/git');
const sync = require('../lib/sync');
const importer = require('../lib/importer');
const { loadPricing } = require('../lib/pricing');
const { resolveConfig } = require('../lib/config');
const { Dataset } = require('../lib/aggregate');

const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

let repo;
let ctx;
const spool = () => {
  try {
    return fs.readFileSync(path.join(repoDir, '.git', 'tokentaby', 'spool.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

test.before(() => {
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'feat/TKT-7-import'], { cwd: repoDir, env: { ...process.env, HOME: tmp, GIT_CONFIG_NOSYSTEM: '1' } });
  store.setDataDir(path.join(tmp, 'data'));
  repo = git.findRepo(repoDir);
  sync.init(repo, { promptMode: 'full' });
  const state = store.readState(repo);
  ctx = { repo, dev: 'sami', cfg: resolveConfig(repo.root, {}), state, pricing: loadPricing(repo.root) };

  // Codex: cumulative totals (one repeated), cached inside input, reasoning inside output
  const tc = (input, cached, output, reasoning) => ({ timestamp: '2026-10-20T10:00:05Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output } } } });
  write(path.join(tmp, 'codex', 'sessions', '2026', '10', '20', 'rollout-2026-10-20T10-00-00-cdx1.jsonl'), jsonl([
    { timestamp: '2026-10-20T10:00:00Z', type: 'session_meta', payload: { id: 'cdx1', timestamp: '2026-10-20T10:00:00Z', cwd: path.join(repoDir, 'src'), originator: 'codex-tui', git: { branch: 'feat/TKT-7-import' } } },
    { timestamp: '2026-10-20T10:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: '2026-10-20T10:00:01Z', type: 'turn_context', payload: { turn_id: 't1', cwd: repoDir, model: 'gpt-5.5' } },
    { timestamp: '2026-10-20T10:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'add pagination to the orders API' } },
    tc(1000, 200, 50, 10),
    tc(1000, 200, 50, 10),
    tc(2500, 1200, 130, 30),
    { timestamp: '2026-10-20T10:00:09Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
  ]));
  // Codex App session in another project: must be ignored
  write(path.join(tmp, 'codex', 'sessions', '2026', '10', '20', 'rollout-2026-10-20T11-00-00-cdx2.jsonl'), jsonl([
    { timestamp: '2026-10-20T11:00:00Z', type: 'session_meta', payload: { id: 'cdx2', cwd: elsewhere, originator: 'Codex Desktop' } },
    { timestamp: '2026-10-20T11:00:01Z', type: 'turn_context', payload: { model: 'gpt-5.5' } },
    tc(9000, 0, 900, 0),
  ]));

  // Gemini CLI: message re-appended once tokens arrive, then a rewind dropping a later exchange
  const gdir = path.join(tmp, 'gemini-home', '.gemini', 'tmp', 'web-app');
  write(path.join(gdir, '.project_root'), repoDir + '\n');
  write(path.join(gdir, 'chats', 'session-2026-10-21T09-00-gem1abcd.jsonl'), jsonl([
    { sessionId: 'gem1', projectHash: 'x', startTime: '2026-10-21T09:00:00Z', kind: 'main' },
    { id: 'u1', timestamp: '2026-10-21T09:00:00Z', type: 'user', content: [{ text: 'explain the retry logic' }] },
    { id: 'g1', timestamp: '2026-10-21T09:00:02Z', type: 'gemini', content: '', model: 'gemini-3-pro', tokens: null },
    { id: 'g1', timestamp: '2026-10-21T09:00:02Z', type: 'gemini', content: 'It retries…', model: 'gemini-3-pro', tokens: { input: 4000, output: 300, cached: 1000, thoughts: 100, tool: 0, total: 4400 } },
    { id: 'u2', timestamp: '2026-10-21T09:01:00Z', type: 'user', content: 'oops' },
    { id: 'g2', timestamp: '2026-10-21T09:01:02Z', type: 'gemini', content: 'x', model: 'gemini-3-pro', tokens: { input: 99999, output: 9, cached: 0, total: 100008 } },
    { $rewindTo: 'u2' },
  ]));

  // Qwen Code: append-only ChatRecords with cwd and gitBranch
  write(path.join(tmp, 'qwen', 'projects', repoDir.replace(/[^A-Za-z0-9]/g, '-'), 'chats', 'qw1.jsonl'), jsonl([
    { uuid: 'q1', sessionId: 'qw1', timestamp: '2026-10-21T12:00:00Z', type: 'user', cwd: repoDir, gitBranch: 'feat/TKT-8-qwen', promptId: 'p1', message: { role: 'user', parts: [{ text: 'write a migration' }] } },
    { uuid: 'q2', sessionId: 'qw1', timestamp: '2026-10-21T12:00:03Z', type: 'assistant', cwd: repoDir, promptId: 'p1', model: 'qwen3-coder-plus', usageMetadata: { promptTokenCount: 3000, cachedContentTokenCount: 2000, candidatesTokenCount: 400, thoughtsTokenCount: 50, totalTokenCount: 3400 } },
    { uuid: 'q2', sessionId: 'qw2', timestamp: '2026-10-21T12:00:03Z', type: 'assistant', cwd: repoDir, forkedFrom: { sessionId: 'qw1' }, model: 'qwen3-coder-plus', usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 400 } },
  ]));

  // OpenCode, file storage (pre-SQLite versions): a parent session and a subagent child
  const oc = path.join(tmp, 'xdg', 'opencode', 'storage');
  write(path.join(oc, 'session', 'proj1', 'ses_a.json'), JSON.stringify({ id: 'ses_a', directory: repoDir, time: { created: Date.parse('2026-10-22T08:00:00Z'), updated: Date.parse('2026-10-22T08:05:00Z') } }));
  write(path.join(oc, 'session', 'proj1', 'ses_b.json'), JSON.stringify({ id: 'ses_b', parentID: 'ses_a', directory: repoDir, time: { created: Date.parse('2026-10-22T08:01:00Z'), updated: Date.parse('2026-10-22T08:02:00Z') } }));
  write(path.join(oc, 'message', 'ses_a', 'msg_1.json'), JSON.stringify({ id: 'msg_1', role: 'user', time: { created: Date.parse('2026-10-22T08:00:00Z') } }));
  write(path.join(oc, 'part', 'msg_1', 'prt_1.json'), JSON.stringify({ type: 'text', text: 'fix the flaky test' }));
  write(path.join(oc, 'message', 'ses_a', 'msg_2.json'), JSON.stringify({ id: 'msg_2', role: 'assistant', parentID: 'msg_1', modelID: 'claude-sonnet-4-5', providerID: 'anthropic', cost: 0, time: { created: Date.parse('2026-10-22T08:00:05Z'), completed: Date.parse('2026-10-22T08:00:20Z') }, tokens: { input: 100, output: 500, reasoning: 0, cache: { read: 20000, write: 3000 } } }));
  write(path.join(oc, 'message', 'ses_a', 'msg_3.json'), JSON.stringify({ id: 'msg_3', role: 'assistant', modelID: 'claude-sonnet-4-5', time: { created: Date.parse('2026-10-22T08:04:00Z') }, tokens: { input: 5, output: 5, cache: { read: 0, write: 0 } } }));
  write(path.join(oc, 'message', 'ses_b', 'msg_9.json'), JSON.stringify({ id: 'msg_9', role: 'assistant', agent: 'explore', modelID: 'gpt-5.4-mini', cost: 0.0123, time: { created: Date.parse('2026-10-22T08:01:10Z'), completed: Date.parse('2026-10-22T08:01:30Z') }, tokens: { input: 800, output: 90, cache: { read: 0, write: 0 } } }));
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('codex: deltas of cumulative totals, cached split out, app vs CLI by originator', () => {
  const codex = require('../lib/sources/codex');
  const s = codex.list().find((x) => x.key.endsWith('cdx1'));
  assert.equal(codex.describe(s).tool, 'codex-cli');
  assert.equal(codex.describe(codex.list().find((x) => x.key.endsWith('cdx2'))).tool, 'codex-app');
  const r = codex.read(s, null);
  assert.equal(r.records.length, 2, 'the repeated total adds nothing');
  assert.deepEqual(r.records.map((x) => [x.in, x.cr, x.out]), [[800, 200, 50], [500, 1000, 80]]);
  assert.equal(r.prompts[0].text, 'add pagination to the orders API');
  assert.equal(codex.read(s, r.wm).records.length, 0, 'nothing new after the watermark');
});

test('gemini: last copy per message id wins, rewinds drop messages, thoughts billed as output', () => {
  const gem = require('../lib/sources/gemini');
  const s = gem.list()[0];
  const d = gem.describe(s);
  assert.equal(d.cwd, repoDir);
  const r = gem.read(s, null);
  assert.equal(r.records.length, 1);
  assert.deepEqual([r.records[0].in, r.records[0].cr, r.records[0].out], [3000, 1000, 400]);
  assert.deepEqual(r.prompts.map((p) => p.text), ['explain the retry logic']);
});

test('importer: only this repo, tagged by tool, idempotent', () => {
  const r = importer.importUsage(ctx);
  assert.deepEqual(Object.keys(r.tools).sort(), ['codex-cli', 'gemini-cli', 'opencode', 'qwen-code']);
  assert.deepEqual(r.errors, []);
  const ev = spool();
  const turns = ev.filter((e) => e.t === 'turn');
  const by = (tool) => turns.filter((e) => e.tool === tool);
  // codex: one turn row (same turn, same model) summing both requests
  assert.equal(by('codex-cli').length, 1);
  assert.deepEqual(['in', 'cr', 'out', 'req'].map((k) => by('codex-cli')[0][k]), [1300, 1200, 130, 2]);
  assert.equal(by('codex-cli')[0].task, 'TKT-7', 'ticket from the session branch');
  assert.equal(by('qwen-code')[0].task, 'TKT-8');
  assert.deepEqual(['in', 'cr', 'out'].map((k) => by('qwen-code')[0][k]), [1000, 2000, 400], 'forked copy skipped');
  // opencode: unfinished message skipped, subagent under the parent session, provider cost kept
  const oc = by('opencode');
  assert.equal(oc.length, 2);
  const sub = oc.find((e) => e.agent !== 'main');
  assert.deepEqual([sub.session, sub.agent, sub.agent_type, sub.usd], ['ses_a', 'ses_b', 'explore', 0.0123]);
  const main = oc.find((e) => e.agent === 'main');
  assert.deepEqual([main.cw, main.cr], [3000, 20000]);
  assert.ok(main.usd > 0, 'priced from the table when the provider reports no cost');
  // prompts under the repo's mode (full here), one per tool session, none for subagents
  assert.deepEqual(ev.filter((e) => e.t === 'prompt').map((e) => e.text).sort(), ['add pagination to the orders API', 'explain the retry logic', 'fix the flaky test', 'write a migration']);
  assert.equal(ev.filter((e) => e.t === 'session').length, 4);
  for (const e of ev) assert.equal(e.dev, 'sami');
  const again = importer.importUsage(ctx);
  assert.equal(spool().length, ev.length, 'a second run adds nothing');
  assert.deepEqual(Object.values(again.tools).map((t) => t.turnRows), []);
});

test('the tool dimension in the aggregates', () => {
  const ds = new Dataset(store.readAllEvents(repo), { me: 'sami' });
  const s = ds.summary({ from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(s.byTool.map((t) => t.tool).sort(), ['codex-cli', 'gemini-cli', 'opencode', 'qwen-code']);
  assert.equal(ds.summary({ from: '2026-10-01', to: '2026-10-31', tool: 'qwen-code' }).totals.in, 1000);
  assert.ok(ds.toolIds().includes('opencode'));
});

test('copilot CLI from session-store.db (needs node:sqlite)', (t) => {
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch {
    return t.skip('node:sqlite not available');
  }
  fs.mkdirSync(path.join(tmp, 'copilot'), { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(tmp, 'copilot', 'session-store.db'));
  db.exec(`create table sessions (id text, cwd text, repository text, host_type text, branch text, summary text, created_at text, updated_at text);
    create table assistant_usage_events (session_id text, turn_index integer, model text, copilot_usage_model text, input_tokens integer, output_tokens integer, cache_read_tokens integer, cache_write_tokens integer, reasoning_tokens integer, total_nano_aiu integer, duration_ms integer, created_at text);
    insert into sessions values ('cop1', '${repoDir}', 'o/web-app', 'cli', 'feat/TKT-9-x', '', '2026-10-22T09:00:00Z', '2026-10-22T09:05:00Z');
    insert into assistant_usage_events values ('cop1', 0, 'claude-sonnet-4.5', 'x', 12000, 400, 9000, 1000, 0, 0, 0, '2026-10-22T09:00:10Z');
    insert into assistant_usage_events values ('cop1', 0, 'claude-sonnet-4.5', 'x', 13000, 100, 12000, 0, 0, 0, 0, '2026-10-22T09:00:20Z');`);
  db.close();
  write(path.join(tmp, 'copilot', 'session-state', 'cop1', 'events.jsonl'), jsonl([{ type: 'user.message', id: 'e1', timestamp: '2026-10-22T09:00:00Z', data: { content: 'rename the config flag' } }]));
  const r = importer.importUsage(ctx, { tools: ['copilot'] });
  assert.equal(r.tools['copilot-cli'].turnRows, 1);
  const row = spool().filter((e) => e.tool === 'copilot-cli' && e.t === 'turn')[0];
  assert.deepEqual(['in', 'cr', 'cw', 'out', 'req', 'task'].map((k) => row[k]), [3000, 21000, 1000, 500, 2, 'TKT-9'], 'input excludes cache reads/writes');
  assert.ok(row.usd > 0, 'dotted Claude id priced');
  assert.ok(spool().some((e) => e.t === 'prompt' && e.tool === 'copilot-cli' && e.text === 'rename the config flag'));
});

test('opencode from opencode.db (needs node:sqlite)', (t) => {
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch {
    return t.skip('node:sqlite not available');
  }
  const file = path.join(tmp, 'xdg', 'opencode', 'opencode.db');
  const db = new sqlite.DatabaseSync(file);
  // the columns OpenCode's drizzle schema has (only those tokentaby reads, plus the NOT NULL ones)
  db.exec(`create table session (id text primary key, project_id text not null, parent_id text, slug text not null, directory text not null, title text not null, version text not null, time_created integer not null, time_updated integer not null);
    create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
    create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);`);
  const at = Date.parse('2026-10-22T10:00:00Z');
  db.prepare('insert into session values (?,?,?,?,?,?,?,?,?)').run('ses_db', 'p', null, 's', repoDir, 't', '1.0', at, at + 60000);
  db.prepare('insert into message values (?,?,?,?,?)').run('msg_u', 'ses_db', at, at, JSON.stringify({ role: 'user', time: { created: at } }));
  db.prepare('insert into part values (?,?,?,?,?,?)').run('prt_u', 'msg_u', 'ses_db', at, at, JSON.stringify({ type: 'text', text: 'speed up the build' }));
  db.prepare('insert into message values (?,?,?,?,?)').run('msg_a', 'ses_db', at + 1000, at + 9000, JSON.stringify({ role: 'assistant', parentID: 'msg_u', modelID: 'claude-opus-4-5', providerID: 'anthropic', cost: 0, time: { created: at + 1000, completed: at + 9000 }, tokens: { input: 50, output: 700, reasoning: 0, cache: { read: 15000, write: 2000 } } }));
  db.close();
  const r = importer.importUsage(ctx, { tools: ['opencode'] });
  assert.equal(r.tools.opencode.turnRows, 1, 'only the new database session; the file-storage ones are already imported');
  const row = spool().find((e) => e.tool === 'opencode' && e.session === 'ses_db' && e.t === 'turn');
  assert.deepEqual(['in', 'out', 'cr', 'cw', 'model'].map((k) => row[k]), [50, 700, 15000, 2000, 'claude-opus-4-5']);
  assert.ok(spool().some((e) => e.t === 'prompt' && e.session === 'ses_db' && e.text === 'speed up the build'));
});

test('kimi code: usage.record per step, model alias resolved, replayed records counted once', () => {
  const home = process.env.KIMI_CODE_HOME;
  const sdir = path.join(home, 'sessions', 'wd_x', 'session_k1');
  write(path.join(home, 'session_index.jsonl'), jsonl([{ sessionId: 'k1', sessionDir: sdir, workDir: repoDir }]));
  write(path.join(home, 'config.toml'), '[models."kimi-code/k2"]\nprovider = "managed:kimi-code"\nmodel = "kimi-k2.7-code"\n');
  const step = (time, n) => ({ type: 'usage.record', model: 'kimi-code/k2', usage: { inputOther: n, output: 100, inputCacheRead: 5000, inputCacheCreation: 0 }, usageScope: 'turn', time });
  write(path.join(sdir, 'agents', 'main', 'wire.jsonl'), jsonl([
    { type: 'metadata', protocol_version: '1', created_at: 1 },
    { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'add a health check endpoint' }], origin: { kind: 'user' } }, time: Date.parse('2026-10-22T07:00:00Z') },
    step(Date.parse('2026-10-22T07:00:05Z'), 1200),
    step(Date.parse('2026-10-22T07:00:09Z'), 300),
    { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }], origin: { kind: 'injection' } }, time: Date.parse('2026-10-22T07:00:10Z') },
    step(Date.parse('2026-10-22T08:00:00Z'), 1200),
  ]));
  const r = importer.importUsage(ctx, { tools: ['kimi'] });
  assert.equal(r.tools['kimi-code'].turnRows, 1);
  const row = spool().find((e) => e.tool === 'kimi-code' && e.t === 'turn');
  assert.deepEqual(['in', 'out', 'cr', 'req', 'model'].map((k) => row[k]), [1500, 200, 10000, 2, 'kimi-k2.7-code'], 'the replayed step is not counted again');
  assert.ok(row.usd > 0);
  assert.deepEqual(spool().filter((e) => e.tool === 'kimi-code' && e.t === 'prompt').map((e) => e.text), ['add a health check endpoint']);
});

test('hermes agent: growth of cumulative per-model counters (needs node:sqlite)', (t) => {
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch {
    return t.skip('node:sqlite not available');
  }
  fs.mkdirSync(process.env.HERMES_HOME, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(process.env.HERMES_HOME, 'state.db'));
  db.exec(`create table sessions (id text, cwd text, git_branch text, started_at real, ended_at real, parent_session_id text);
    create table session_model_usage (session_id text, model text, billing_provider text, billing_base_url text, billing_mode text, task text, input_tokens integer, output_tokens integer, cache_read_tokens integer, cache_write_tokens integer, reasoning_tokens integer, api_call_count integer, first_seen real, last_seen real);`);
  const t0 = Date.parse('2026-10-22T06:00:00Z') / 1000;
  db.prepare('insert into sessions values (?,?,?,?,?,?)').run('h1', repoDir, 'feat/TKT-11-h', t0, null, null);
  db.prepare('insert into session_model_usage values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('h1', 'gpt-5.4', 'openai', '', 'api', '', 1000, 200, 3000, 0, 0, 2, t0, t0 + 60);
  const r1 = importer.importUsage(ctx, { tools: ['hermes'] });
  assert.equal(r1.tools['hermes-agent'].turnRows, 1);
  db.prepare('update session_model_usage set input_tokens = 1500, output_tokens = 260, last_seen = ? where session_id = ?').run(t0 + 120, 'h1');
  db.close();
  importer.importUsage(ctx, { tools: ['hermes'] });
  const rows = spool().filter((e) => e.tool === 'hermes-agent' && e.t === 'turn');
  assert.deepEqual(rows.map((e) => [e.in, e.out, e.cr]), [[1000, 200, 3000], [500, 60, 0]], 'the second import logs only the growth');
  assert.equal(rows[0].task, 'TKT-11');
});

test('cursor: dashboard CSV export, model labels mapped, re-import deduplicated', () => {
  const csv = path.join(tmp, 'cursor-usage.csv');
  write(csv, [
    'Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost',
    '"2026-10-20T09:15:00.000Z",,,Included,claude-4.5-sonnet-thinking,No,"12,000",10000,40000,900,52900,Included',
    '"2026-10-20T11:15:00.000Z",,,Included,claude-4.5-sonnet-thinking,No,2000,2000,8000,100,10100,Included',
    '"2026-10-21T10:00:00.000Z",,,Usage-based,gpt-5,No,3000,3000,0,400,3400,$0.01',
  ].join('\n') + '\n');
  const r = importer.importCursorCsv(ctx, csv);
  assert.deepEqual([r.rows, r.imported, r.turnRows], [3, 3, 2]);
  const rows = spool().filter((e) => e.tool === 'cursor');
  const sonnet = rows.find((e) => e.model === 'claude-sonnet-4-5');
  assert.deepEqual(['in', 'cw', 'cr', 'out', 'req', 'session'].map((k) => sonnet[k]), [12000, 2000, 48000, 1000, 2, 'cursor-2026-10-20']);
  assert.ok(sonnet.usd > 0 && rows.find((e) => e.model === 'gpt-5').usd > 0);
  assert.equal(importer.importCursorCsv(ctx, csv).duplicate, 3);
  assert.equal(spool().filter((e) => e.tool === 'cursor').length, 2);
});

test('antigravity: workspaces from state.vscdb, usage from the language server, retried while closed (needs node:sqlite)', (t) => {
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch {
    return t.skip('node:sqlite not available');
  }
  // protobuf writer for the fixture: field(n, value) with varints and nested messages
  const varint = (n) => {
    const out = [];
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n) b |= 128;
      out.push(b);
    } while (n);
    return Buffer.from(out);
  };
  const field = (n, v) => (typeof v === 'number' ? Buffer.concat([varint(n * 8), varint(v)]) : Buffer.concat([varint(n * 8 + 2), varint(Buffer.byteLength(v)), Buffer.from(v)]));
  const msg = (...parts) => Buffer.concat(parts);
  const summary = (id, dir, created, updated) => {
    const inner = msg(field(2, 12), field(3, msg(field(1, updated))), field(7, msg(field(1, created))), field(9, msg(field(1, `file://${dir}`), field(2, `file://${dir}`))));
    return field(1, msg(field(1, id), field(2, msg(field(1, inner.toString('base64'))))));
  };
  const t0 = Date.parse('2026-10-22T05:00:00Z') / 1000;
  const db = process.env.ANTIGRAVITY_STATE_DB;
  const d = new sqlite.DatabaseSync(db);
  d.exec('create table ItemTable (key text unique on conflict replace, value blob)');
  d.prepare('insert into ItemTable values (?, ?)').run('antigravityUnifiedStateSync.trajectorySummaries', msg(summary('ag-1', repoDir, t0, t0 + 300), summary('ag-2', elsewhere, t0, t0 + 60)).toString('base64'));
  d.close();

  const ag = require('../lib/sources/antigravity');
  assert.deepEqual(ag.list().map((s) => [s.key, s.cwd]), [['ag-1', repoDir], ['ag-2', elsewhere]]);

  // Antigravity closed: nothing logged, nothing marked done
  const snap = path.join(tmp, 'ag-snapshot.json');
  write(snap, JSON.stringify({ ok: false, error: 'Antigravity is not running' }));
  process.env.TOKENTABY_ANTIGRAVITY_SNAPSHOT = snap;
  const closed = importer.importUsage(ctx, { tools: ['antigravity'] });
  assert.deepEqual([closed.tools.antigravity.turnRows, closed.tools.antigravity.waiting], [0, 1]);

  // open: one response with a thinking/response split, one retried response with the same id
  const use = (responseId, extra) => ({ responseId, model: 'MODEL_PLACEHOLDER_M26', input: 4000, output: 900, thinking: 300, response: 600, cacheRead: 20000, cacheWrite: 1000, ts: '2026-10-22T05:01:00Z', ...extra });
  write(snap, JSON.stringify({ ok: true, models: { MODEL_PLACEHOLDER_M26: 'Claude Opus 4.6 (Thinking)' }, cascades: { 'ag-1': { usage: [use('r1'), use('r1'), use('r2', { thinking: 0, response: 0, output: 50, input: 10, cacheRead: 0, cacheWrite: 0 })] } } }));
  const r = importer.importUsage(ctx, { tools: ['antigravity'] });
  assert.equal(r.tools.antigravity.sessions, 1, 'the other workspace is skipped');
  const rows = spool().filter((e) => e.tool === 'antigravity' && e.t === 'turn');
  assert.deepEqual(rows.map((e) => [e.model, e.in, e.out, e.cr, e.cw]), [['claude-opus-4.6', 4000, 900, 20000, 1000], ['claude-opus-4.6', 10, 50, 0, 0]], 'r1 once; output = response + thinking, else the total');
  assert.ok(rows.every((e) => e.usd > 0), 'priced as claude-opus-4-6');
  assert.equal(importer.importUsage(ctx, { tools: ['antigravity'] }).tools.antigravity, undefined, 'nothing new: the watermark matches');
  delete process.env.TOKENTABY_ANTIGRAVITY_SNAPSHOT;

  // current builds: a plain SQLite conversation, readable without the app running
  const gdir = process.env.ANTIGRAVITY_GEMINI_DIR;
  fs.mkdirSync(path.join(gdir, 'antigravity-ide', 'conversations'), { recursive: true });
  const conv = new sqlite.DatabaseSync(path.join(gdir, 'antigravity-ide', 'conversations', 'ag-db.db'));
  conv.exec('create table gen_metadata (idx integer primary key, data blob, size integer not null default 0); create table trajectory_metadata_blob (id text primary key, data blob)');
  conv.prepare('insert into trajectory_metadata_blob values (?, ?)').run('main', msg(field(3, msg(field(1, `file://${path.join(repoDir, 'src')}`))), field(7, 'x')));
  const call = (idx, rid, input, cr, thinking, response, t) =>
    conv.prepare('insert into gen_metadata (idx, data) values (?, ?)').run(idx, msg(field(1, msg(field(3, 1318), field(4, msg(field(1, 1318), field(2, input), field(3, thinking + response), field(5, cr), field(9, thinking), field(10, response), field(11, rid))), field(9, msg(field(4, msg(field(1, t))))), field(19, 'gemini-3.8-flash-n'), field(21, 'Gemini 3.8 Flash (High)')))));
  call(0, 'resp-a', 16000, 0, 100, 50, t0 + 600);
  call(1, 'resp-b', 2000, 15000, 20, 60, t0 + 610);
  conv.close();
  const viaDb = importer.importUsage(ctx, { tools: ['antigravity'] });
  assert.equal(viaDb.tools.antigravity.turnRows, 2);
  const dbRows = spool().filter((e) => e.tool === 'antigravity' && e.session === 'ag-db');
  assert.deepEqual(dbRows.filter((e) => e.t === 'turn').map((e) => [e.model, e.in, e.out, e.cr]), [['gemini-3.8-flash', 16000, 150, 0], ['gemini-3.8-flash', 2000, 80, 15000]]);
  assert.ok(dbRows.every((e) => e.t !== 'turn' || e.usd > 0));

});
