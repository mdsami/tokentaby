#!/usr/bin/env node
'use strict';
// Asks a running Antigravity language server for per-response token usage.
// Antigravity encrypts its conversation files, so the only readable source is
// the server's local Connect-JSON API (the route codeburn and tokscale use):
// find the process, its CSRF token and ports, then
// GetAllCascadeTrajectories and GetCascadeTrajectoryGeneratorMetadata.
// Run as a child process (the importer is synchronous); prints one JSON
// object: { ok, error?, cascades: { <id>: { lastModified, usage: [...] } }, models }.

const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

const SERVICE = '/exa.language_server_pb.LanguageServerService/';

/** [{ pid, csrf, ports }] for Antigravity language servers, from ps + lsof. */
function servers() {
  const ps = spawnSync('ps', ['-ww', '-eo', 'pid=,args='], { encoding: 'utf8' });
  if (ps.status !== 0) throw new Error('cannot list processes (ps)');
  const out = [];
  for (const line of ps.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    const args = m && m[2].toLowerCase();
    if (!m || !(args.includes('language_server') || /\/agy(\s|$)/.test(args)) || !/antigravity|agy/.test(args)) continue;
    const flag = (names) => {
      for (const n of names) {
        const f = new RegExp(`--${n}(?:=|\\s+)(\\S+)`).exec(m[2]);
        if (f) return f[1];
      }
      return null;
    };
    const csrf = flag(['csrf_token', 'csrf-token', 'extension_server_csrf_token', 'extension-server-csrf-token']);
    if (!csrf || csrf.length < 16) continue;
    const ports = new Set();
    for (const n of ['https_server_port', 'https-server-port', 'server_port', 'extension_server_port', 'extension-server-port']) {
      const p = flag([n]);
      if (p && /^\d+$/.test(p)) ports.add(Number(p));
    }
    const lsof = spawnSync('lsof', ['-Pan', '-p', m[1], '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
    for (const l of (lsof.stdout || '').split('\n')) {
      const p = /:(\d+) \(LISTEN\)/.exec(l);
      if (p) ports.add(Number(p[1]));
    }
    out.push({ pid: Number(m[1]), csrf, ports: [...ports] });
  }
  return out;
}

function call(server, method, body, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const mod = server.tls ? https : http;
    const req = mod.request(
      {
        hostname: '127.0.0.1',
        port: server.port,
        path: SERVICE + method,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': server.csrf, 'Content-Length': Buffer.byteLength(data) },
        ...(server.tls ? { rejectUnauthorized: false } : {}),
        timeout,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`${method}: HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(text || '{}'));
          } catch {
            reject(new Error(`${method}: not JSON`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`${method}: timeout`)));
    req.on('error', reject);
    req.end(data);
  });
}

/** The first (port, protocol) of any server that answers a Heartbeat. */
async function connect() {
  for (const s of servers()) {
    for (const port of s.ports) {
      for (const tls of [false, true]) {
        const server = { ...s, port, tls };
        try {
          await call(server, 'Heartbeat', { uuid: '00000000-0000-0000-0000-000000000000' }, 2000);
          return server;
        } catch {
          // next port / protocol
        }
      }
    }
  }
  return null;
}

const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);

async function main() {
  const want = new Set(process.argv.slice(2));
  const server = await connect();
  if (!server) return { ok: false, error: 'Antigravity is not running (no language server answered)' };
  const all = await call(server, 'GetAllCascadeTrajectories', {});
  const raw = all.trajectorySummaries || {};
  const summaries = Array.isArray(raw) ? raw.map((s) => [s.cascadeId || s.trajectoryId, s]) : Object.entries(raw);
  const models = {};
  try {
    const avail = await call(server, 'GetAvailableModels', {});
    // { models: { <key>: { model: "MODEL_PLACEHOLDER_M26", displayName: "Claude Opus 4.6 (Thinking)" } } } (or an array)
    const list = avail.models || (avail.response && avail.response.models) || avail.clientModelConfigs || {};
    for (const [key, m] of Array.isArray(list) ? list.map((x) => [null, x]) : Object.entries(list)) {
      const id = (m && (m.model || m.modelId || (m.modelOrAlias && m.modelOrAlias.model))) || key;
      const label = m && (m.displayName || m.label || m.name);
      if (id && label) models[id] = label;
    }
  } catch {
    // labels are optional
  }
  const cascades = {};
  for (const [id, s] of summaries) {
    if (!id || (want.size && !want.has(id))) continue;
    let meta;
    try {
      meta = await call(server, 'GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id });
    } catch {
      continue;
    }
    const gens = meta.generatorMetadata || (meta.response && meta.response.generatorMetadata) || [];
    const usage = [];
    for (const g of gens) {
      const c = g.chatModel || {};
      // one usage per response; the retry infos repeat it, so they only stand in when it is missing
      const sources = c.usage ? [c.usage] : (c.retryInfos || []).map((r) => r && r.usage);
      for (const u of sources) {
        if (!u) continue;
        usage.push({
          responseId: u.responseId || null,
          model: u.model || c.responseModel || null,
          provider: u.apiProvider || null,
          input: num(u.inputTokens),
          output: num(u.outputTokens),
          thinking: num(u.thinkingOutputTokens),
          response: num(u.responseOutputTokens),
          cacheRead: num(u.cacheReadTokens),
          cacheWrite: num(u.cacheWriteTokens),
          ts: (c.chatStartMetadata && c.chatStartMetadata.createdAt) || null,
        });
      }
    }
    cascades[id] = { lastModified: s.lastModifiedTime || null, steps: num(s.stepCount || s.numSteps), usage };
  }
  return { ok: true, cascades, models };
}

/** --debug: what discovery sees, with tokens masked, and how each port answers. */
async function debug() {
  const ps = spawnSync('ps', ['-ww', '-eo', 'pid=,comm=,args='], { encoding: 'utf8' });
  const mask = (t) => t.replace(/(csrf[_-]?token|token|key|secret)([=\s]+)(\S+)/gi, (m0, k, sep, v) => `${k}${sep}<${v.length} chars>`);
  const lines = ps.stdout.split('\n').filter((l) => /antigravity|agy|language_server|jetski|exa\./i.test(l));
  console.log(`ps exit ${ps.status}; ${lines.length} candidate processes:`);
  for (const l of lines) console.log('  ' + mask(l).slice(0, 600));
  const found = servers();
  console.log(`\nservers with a csrf token: ${found.length}`);
  for (const s of found) {
    console.log(`  pid ${s.pid} ports ${s.ports.join(', ') || '(none)'}`);
    for (const port of s.ports) {
      for (const tls of [false, true]) {
        try {
          await call({ ...s, port, tls }, 'Heartbeat', { uuid: '00000000-0000-0000-0000-000000000000' }, 2000);
          console.log(`    ${tls ? 'https' : 'http'}:${port} Heartbeat OK`);
        } catch (e) {
          console.log(`    ${tls ? 'https' : 'http'}:${port} ${e.message}`);
        }
      }
    }
  }
}

if (require.main === module && process.argv[2] === '--debug') {
  debug().catch((e) => console.log('debug failed:', e.message));
} else if (require.main === module) {
  main()
    .then((r) => process.stdout.write(JSON.stringify(r)))
    .catch((e) => process.stdout.write(JSON.stringify({ ok: false, error: String(e.message || e) })));
}

module.exports = { servers };
