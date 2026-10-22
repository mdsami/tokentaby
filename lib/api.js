'use strict';
// The dashboard's JSON API over a Dataset. Pure — no fs, no network — so the
// local server and the offline snapshot answer every view with the same code.

const { dayOf, toCsv } = require('./aggregate');
const { TOOLS } = require('./tools');

/** Query parameters (URLSearchParams or a plain object) -> Dataset filter. */
function filtersFrom(params) {
  const get = (k) => (typeof params.get === 'function' ? params.get(k) : params[k]);
  const f = {};
  for (const k of ['from', 'to', 'dev', 'tool', 'model', 'task', 'agent', 'branch', 'q']) {
    const v = get(k);
    if (v) f[k] = String(v);
  }
  if (get('prices') === 'current') f.reprice = true;
  const limit = parseInt(get('limit'), 10);
  if (limit >= 0) f.limit = limit;
  return f;
}

/** Response for a GET view, or undefined when the path is not a view. */
function view(ds, pathname, f) {
  switch (pathname) {
    case '/api/summary':
      return ds.summary(f);
    case '/api/periods':
      return ds.periods(f);
    case '/api/pulse':
      return ds.pulse(f);
    case '/api/devs':
      return ds.devs(f);
    case '/api/models':
      return { models: ds.models(f), series: ds.modelSeries(f) };
    case '/api/agents':
      return ds.agents(f);
    case '/api/tasks':
      return ds.tasks(f);
    case '/api/prompts':
      return ds.promptLog(f);
    default: {
      const m = /^\/api\/devs\/([^/]+)$/.exec(pathname);
      return m ? ds.devDetail(decodeURIComponent(m[1]), f) : undefined;
    }
  }
}

/** /api/meta body. pricing: compiled table; extra: repo, version, pricingFile. */
function meta(ds, pricing, extra = {}) {
  return {
    repo: extra.repo || null,
    me: ds.me,
    devs: ds.devIds().map((id) => ({ id, name: ds.name(id) })),
    names: ds.names,
    span: ds.span(),
    promptMode: ds.cfg ? ds.cfg.prompt_mode : null,
    sync: ds.cfg ? ds.cfg.sync : null,
    currency: ds.cfg ? ds.cfg.currency : 'USD',
    fx: pricing.fx,
    pricing,
    pricingFile: extra.pricingFile || null,
    models: ds.modelRank(),
    agentTypes: [...new Set(ds.all.usage.map((r) => r.type))].sort(),
    tools: ds.toolIds(),
    toolNames: TOOLS,
    tasks: [...new Set(ds.all.usage.map((r) => r.task).filter(Boolean))].sort(),
    version: extra.version || null,
    snapshot: extra.snapshot || null,
  };
}

const EXPORT_COLUMNS = {
  turns: ['ts', 'dev', 'session', 'agent', 'agent_type', 'model', 'in', 'out', 'cw', 'cr', 'cw1h', 'req', 'usd', 'task', 'branch', 'dur_ms', 'effort', 'speed', 'ws', 'tool'],
  prompts: ['ts', 'dev', 'session', 'task', 'hash', 'chars', 'text', 'tool'],
  devs: ['dev', 'name', 'sessions', 'prompts', 'in', 'out', 'cw', 'cr', 'tokens', 'usd', 'req', 'favModel', 'subShare', 'lastActive'],
  tasks: ['task', 'title', 'status', 'usd', 'tokens', 'in', 'out', 'cw', 'cr', 'prompts', 'sessions', 'durMs', 'first', 'last'],
  models: ['model', 'usd', 'tokens', 'in', 'out', 'cw', 'cr', 'req', 'turns', 'prompts'],
};

/** Rows for an export kind, honouring filters. events: raw events. */
function exportRows(ds, events, kind, f) {
  const inRange = (day) => (!f.from || day >= f.from) && (!f.to || day <= f.to);
  if (kind === 'turns' || kind === 'prompts') {
    const t = kind === 'turns' ? 'turn' : 'prompt';
    return events
      .filter((e) => e.t === t && inRange(dayOf(e.ts)) && (!f.dev || e.dev === f.dev) && (!f.tool || (e.tool || 'claude-code') === f.tool) && (!f.task || e.task === f.task) && (!f.model || e.model === f.model))
      .sort((a, b) => (a.ts < b.ts ? -1 : 1));
  }
  if (kind === 'devs') return ds.devs(f);
  if (kind === 'tasks') return ds.tasks(f).tasks;
  if (kind === 'models') return ds.models(f);
  throw new Error(`unknown export kind "${kind}"`);
}

/** { filename, type, body } for an export download. */
function exportFile(ds, events, kind, format, f) {
  const rows = exportRows(ds, events, kind, f);
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'json') return { filename: `tokentaby-${kind}-${stamp}.json`, type: 'application/json; charset=utf-8', body: JSON.stringify(rows, null, 2) };
  return { filename: `tokentaby-${kind}-${stamp}.csv`, type: 'text/csv; charset=utf-8', body: toCsv(rows, EXPORT_COLUMNS[kind]) };
}

module.exports = { filtersFrom, view, meta, exportRows, exportFile, EXPORT_COLUMNS };
