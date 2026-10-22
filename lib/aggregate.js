'use strict';
// In-memory aggregation shared by the dashboard API, `tokentaby summary`,
// `tokentaby query` and the exports. Days are bucketed in local time.

const { cost, round } = require('./pricing');

const pad = (n) => String(n).padStart(2, '0');
const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);

function dayOf(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return dayOf(new Date(y, m - 1, d + n));
}

function today() {
  return dayOf(new Date());
}

function dayRange(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < 3700; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Monday of the week containing `day`. */
function weekStart(day) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return addDays(day, -((dt.getDay() + 6) % 7));
}

// ---------------------------------------------------------------- normalisation

/**
 * Split raw events into uniform records. Rollup rows (squashed old months)
 * become the same records as the raw events they replaced.
 */
function normalize(events) {
  const usage = [];
  const prompts = [];
  const sessions = [];
  const tasks = [];
  for (const e of events) {
    if (!e || !e.t) continue;
    if (e.t === 'turn') {
      const sub = e.agent && e.agent !== 'main';
      usage.push({
        day: dayOf(e.ts),
        ts: e.ts,
        dev: e.dev,
        tool: e.tool || 'claude-code',
        session: e.session || null,
        agent: e.agent || 'main',
        type: sub ? e.agent_type || 'subagent' : 'main',
        agents: sub ? 1 : 0,
        model: e.model || 'unknown',
        in: num(e.in),
        out: num(e.out),
        cw: num(e.cw),
        cr: num(e.cr),
        cw1h: num(e.cw1h),
        ws: num(e.ws),
        req: num(e.req) || 1,
        usd: typeof e.usd === 'number' ? e.usd : null,
        task: e.task || null,
        branch: e.branch || null,
        dur: num(e.dur_ms),
        turns: 1,
        speed: e.speed || null,
        effort: e.effort || null,
      });
    } else if (e.t === 'rollup' && e.k === 'turn') {
      const sub = e.agent && e.agent !== 'main';
      usage.push({
        day: e.day,
        ts: `${e.day}T12:00:00`,
        dev: e.dev,
        tool: e.tool || 'claude-code',
        session: null,
        agent: sub ? 'sub' : 'main',
        type: sub ? e.agent_type || 'subagent' : 'main',
        agents: num(e.agents),
        model: e.model || 'unknown',
        in: num(e.in),
        out: num(e.out),
        cw: num(e.cw),
        cr: num(e.cr),
        cw1h: num(e.cw1h),
        ws: num(e.ws),
        req: num(e.req) || 1,
        usd: typeof e.usd === 'number' ? e.usd : null,
        task: e.task || null,
        branch: e.branch || null,
        dur: num(e.dur_ms),
        turns: num(e.n) || 1,
        speed: e.speed || null,
        effort: null,
        rolled: true,
      });
    } else if (e.t === 'prompt') {
      prompts.push({ day: dayOf(e.ts), ts: e.ts, dev: e.dev, tool: e.tool || 'claude-code', session: e.session || null, task: e.task || null, hash: e.hash || null, chars: num(e.chars), text: typeof e.text === 'string' ? e.text : null, n: 1 });
    } else if (e.t === 'rollup' && e.k === 'prompt') {
      prompts.push({ day: e.day, ts: `${e.day}T12:00:00`, dev: e.dev, tool: e.tool || 'claude-code', session: null, task: e.task || null, hash: null, chars: num(e.chars), text: null, n: num(e.n), rolled: true });
    } else if (e.t === 'session') {
      sessions.push({ day: dayOf(e.ts), ts: e.ts, dev: e.dev, tool: e.tool || 'claude-code', session: e.session, event: e.event, source: e.source || null, branch: e.branch || null, reason: e.reason || null, n: e.event === 'start' ? 1 : 0 });
    } else if (e.t === 'rollup' && e.k === 'session') {
      sessions.push({ day: e.day, ts: `${e.day}T12:00:00`, dev: e.dev, tool: e.tool || 'claude-code', session: null, event: 'start', n: num(e.n), rolled: true });
    } else if (e.t === 'task') {
      tasks.push({ day: dayOf(e.ts), ts: e.ts, dev: e.dev, session: e.session || null, task: e.task || null, status: e.status || null, title: e.title || null, tid: e.tid || null });
    }
  }
  const byTs = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
  usage.sort(byTs);
  prompts.sort(byTs);
  return { usage, prompts, sessions, tasks };
}

// ---------------------------------------------------------------- dataset

class Dataset {
  /**
   * events: raw events; opts.me: current dev id; opts.pricing: compiled
   * pricing table, used when opts.reprice asks to recompute every row's cost
   * with today's prices instead of the write-time estimate.
   */
  constructor(events, opts = {}) {
    this.all = normalize(events);
    this.me = opts.me || null;
    this.pricing = opts.pricing || null;
    this.names = opts.names || {};
  }

  /** Records within the filter. f: { from, to, dev, tool, model, task, agent, branch, reprice } */
  select(f = {}) {
    const inRange = (r) => (!f.from || r.day >= f.from) && (!f.to || r.day <= f.to);
    const match = (r) => inRange(r) && (!f.dev || r.dev === f.dev) && (!f.tool || r.tool === f.tool) && (!f.task || r.task === f.task) && (!f.branch || r.branch === f.branch);
    let usage = this.all.usage.filter((r) => match(r) && (!f.model || r.model === f.model) && (!f.agent || r.type === f.agent));
    if (f.reprice && this.pricing) usage = usage.map((r) => ({ ...r, usd: reprice(this.pricing, r) }));
    const noUsageFilter = !f.model && !f.agent;
    return {
      usage,
      prompts: this.all.prompts.filter((r) => match(r) && noUsageFilter),
      sessions: this.all.sessions.filter((r) => inRange(r) && (!f.dev || r.dev === f.dev) && (!f.tool || r.tool === f.tool)),
      tasks: this.all.tasks.filter((r) => match(r)),
    };
  }

  /** Earliest and latest day with any data. */
  span() {
    const days = [...this.all.usage, ...this.all.prompts].map((r) => r.day).filter(Boolean);
    if (!days.length) return { first: null, last: null };
    return { first: days.reduce((a, b) => (a < b ? a : b)), last: days.reduce((a, b) => (a > b ? a : b)) };
  }

  /** Models by all-time cost — a stable order for assigning chart colors, whatever the filter. */
  modelRank() {
    return rank(groupBy(this.all.usage, (r) => r.model, totalsOf), 'model').map((m) => m.model);
  }

  /** Tools with any logged usage, most used first. */
  toolIds() {
    return rank(groupBy(this.all.usage, (r) => r.tool, totalsOf), 'tool').map((t) => t.tool);
  }

  devIds() {
    return [...new Set([...this.all.usage, ...this.all.prompts, ...this.all.sessions].map((r) => r.dev).filter(Boolean))].sort();
  }

  // -------------------------------------------------------------- views

  summary(f = {}) {
    const to = f.to || today();
    const from = f.from || `${to.slice(0, 7)}-01`;
    const sel = this.select({ ...f, from, to });
    const trendFrom = addDays(to, -29);
    const trend = this.select({ ...f, from: trendFrom, to });
    const dayTotals = groupBy(trend.usage, (r) => r.day, totalsOf);
    // the equally long period right before, for "vs previous N days"
    const len = dayRange(from, to).length;
    const prevRange = { from: addDays(from, -len), to: addDays(from, -1) };
    const prev = this.select({ ...f, ...prevRange });
    const rangeDays = groupBy(sel.usage, (r) => r.day, totalsOf);
    return {
      range: { from, to },
      totals: { ...totalsOf(sel.usage), ...activity(sel), devs: new Set(sel.usage.map((r) => r.dev)).size },
      prev: { range: prevRange, days: len, ...totalsOf(prev.usage), ...activity(prev) },
      me: this.me ? { dev: this.me, ...totalsOf(sel.usage.filter((r) => r.dev === this.me)), ...activity(filterDev(sel, this.me)) } : null,
      byDay: dayRange(from, to).map((day) => ({ day, ...pickTotals(rangeDays.get(day)) })),
      trend: dayRange(trendFrom, to).map((day) => ({ day, ...pickTotals(dayTotals.get(day)) })),
      byModel: rank(groupBy(sel.usage, (r) => r.model, totalsOf), 'model'),
      byAgent: rank(groupBy(sel.usage, (r) => r.type, totalsOf), 'type'),
      byTool: rank(groupBy(sel.usage, (r) => r.tool, totalsOf), 'tool').map((t) => ({ ...t, devs: new Set(sel.usage.filter((r) => r.tool === t.tool).map((r) => r.dev)).size })),
      topDevs: rank(groupBy(sel.usage, (r) => r.dev, totalsOf), 'dev').slice(0, 5).map((d) => ({ ...d, name: this.name(d.dev) })),
      topTasks: rank(groupBy(sel.usage.filter((r) => r.task), (r) => r.task, totalsOf), 'task').slice(0, 5),
    };
  }

  /** today / this week / this month, me vs team — the /tokentaby:usage view. */
  periods(f = {}) {
    const t = f.to || today();
    const ranges = { today: [t, t], week: [weekStart(t), t], month: [`${t.slice(0, 7)}-01`, t] };
    const out = {};
    for (const [k, [from, to]] of Object.entries(ranges)) {
      const sel = this.select({ ...f, from, to });
      out[k] = {
        from,
        to,
        team: { ...totalsOf(sel.usage), ...activity(sel), devs: new Set(sel.usage.map((r) => r.dev)).size },
        me: this.me ? { ...totalsOf(sel.usage.filter((r) => r.dev === this.me)), ...activity(filterDev(sel, this.me)) } : null,
        topModel: (rank(groupBy(sel.usage, (r) => r.model, totalsOf), 'model')[0] || {}).model || null,
      };
    }
    return { me: this.me, ...out };
  }

  /**
   * The overview's headline cards, cost profile per developer and working
   * rhythm. The cards are anchored on f.to (default today) and ignore f.from;
   * profile and rhythm cover the filtered range, trend against the equally
   * long range right before it.
   */
  pulse(f = {}) {
    const t = f.to || today();
    const usd = (from, to) => totalsOf(this.select({ ...f, from, to }).usage).usd;
    const [y, m] = t.split('-').map(Number);
    const monthDays = new Date(y, m, 0).getDate();
    const mtd = usd(`${t.slice(0, 7)}-01`, t);
    const elapsed = Number(t.slice(8, 10));
    const wk = weekStart(t);
    const weekLen = dayRange(wk, t).length;
    const cards = {
      today: { usd: usd(t, t), prev: usd(addDays(t, -1), addDays(t, -1)) },
      week: { usd: usd(wk, t), prev: usd(addDays(wk, -7), addDays(wk, weekLen - 8)), days: weekLen },
      forecast: { usd: round((mtd / elapsed) * monthDays), mtd, elapsed, monthDays },
      devs: { n: new Set(this.select({ ...f, from: `${t.slice(0, 7)}-01`, to: t }).usage.map((r) => r.dev)).size, all: this.devIds().length },
    };

    const from = f.from || addDays(t, -29);
    const sel = this.select({ ...f, from, to: t });
    const len = dayRange(from, t).length;
    const prev = this.select({ ...f, from: addDays(from, -len), to: addDays(from, -1) });
    const prevUsd = groupBy(prev.usage, (r) => r.dev, totalsOf);
    const total = totalsOf(sel.usage).usd;
    const profile = [...groupBy(sel.usage, (r) => r.dev, (rs) => rs)]
      .map(([dev, rows]) => {
        const tt = totalsOf(rows);
        const frontier = totalsOf(rows.filter((r) => isFrontier(r.model))).usd;
        const p = (prevUsd.get(dev) || {}).usd || 0;
        const input = tt.in + tt.cw + tt.cr;
        return {
          dev,
          name: this.name(dev),
          usd: tt.usd,
          tokens: tt.tokens,
          turns: tt.turns,
          share: total ? round(tt.usd / total) : 0,
          frontierUsd: frontier,
          frontierShare: tt.usd ? round(frontier / tt.usd) : 0,
          cacheHit: input ? round(tt.cr / input) : 0,
          trend: p ? round((tt.usd - p) / p) : null,
        };
      })
      .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);

    // weekday (0 = Monday) x local hour, live turns only: rolled-up months have no time of day
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    let turns = 0;
    let offHours = 0;
    for (const r of sel.usage) {
      if (r.rolled || r.type !== 'main') continue;
      const d = new Date(r.ts);
      if (isNaN(d)) continue;
      const hr = d.getHours();
      grid[(d.getDay() + 6) % 7][hr] += 1;
      turns += 1;
      if (hr < 7 || hr >= 22) offHours += 1;
    }
    const byHour = Array.from({ length: 24 }, (_, hr) => grid.reduce((s, row) => s + row[hr], 0));
    const peak = turns ? byHour.indexOf(Math.max(...byHour)) : null;

    return {
      to: t,
      range: { from, to: t, days: len },
      cards,
      profile,
      rhythm: { grid, turns, peakHour: peak, offHours: turns ? round(offHours / turns) : 0 },
    };
  }

  devs(f = {}) {
    const sel = this.select(f);
    const ids = new Set([...sel.usage.map((r) => r.dev), ...sel.prompts.map((r) => r.dev)]);
    return [...ids]
      .map((dev) => {
        const s = filterDev(sel, dev);
        const t = totalsOf(s.usage);
        const sub = totalsOf(s.usage.filter((r) => r.type !== 'main'));
        const models = rank(groupBy(s.usage, (r) => r.model, totalsOf), 'model');
        const fav = [...models].sort((a, b) => b.req - a.req)[0];
        const last = [...s.usage, ...s.prompts].reduce((m, r) => (r.ts > m ? r.ts : m), '');
        return {
          dev,
          name: this.name(dev),
          ...t,
          ...activity(s),
          favModel: fav ? fav.model : null,
          subShare: t.usd ? round(sub.usd / t.usd) : t.tokens ? round(sub.tokens / t.tokens) : 0,
          models: models.map((m) => ({ model: m.model, usd: m.usd, tokens: m.tokens })),
          lastActive: last || null,
        };
      })
      .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
  }

  devDetail(dev, f = {}) {
    const to = f.to || today();
    const from = f.from || addDays(to, -29);
    const sel = this.select({ ...f, from, to, dev });
    const byDay = groupBy(sel.usage, (r) => r.day, totalsOf);
    const promptsPerTask = countBy(sel.prompts, (r) => r.task || '(none)');
    return {
      dev,
      name: this.name(dev),
      range: { from, to },
      totals: { ...totalsOf(sel.usage), ...activity(sel) },
      byDay: dayRange(from, to).map((day) => ({ day, ...pickTotals(byDay.get(day)) })),
      byModel: rank(groupBy(sel.usage, (r) => r.model, totalsOf), 'model'),
      byAgent: rank(groupBy(sel.usage, (r) => r.type, totalsOf), 'type'),
      tasks: rank(groupBy(sel.usage, (r) => r.task || '(none)', totalsOf), 'task').map((t) => ({ ...t, prompts: promptsPerTask.get(t.task) || 0 })),
      prompts: this.promptLog({ ...f, from, to, dev, limit: 200 }).items,
    };
  }

  models(f = {}) {
    const sel = this.select(f);
    return rank(groupBy(sel.usage, (r) => r.model, totalsOf), 'model').map((m) => {
      const rows = sel.usage.filter((r) => r.model === m.model);
      return {
        ...m,
        byDay: [...groupBy(rows, (r) => r.day, totalsOf)].map(([day, t]) => ({ day, usd: t.usd, tokens: t.tokens })).sort((a, b) => (a.day < b.day ? -1 : 1)),
        devs: rank(groupBy(rows, (r) => r.dev, totalsOf), 'dev').map((d) => ({ dev: d.dev, name: this.name(d.dev), usd: d.usd, tokens: d.tokens })),
        tasks: rank(groupBy(rows.filter((r) => r.task), (r) => r.task, totalsOf), 'task').slice(0, 10).map((t) => ({ task: t.task, usd: t.usd, tokens: t.tokens })),
        agents: rank(groupBy(rows, (r) => r.type, totalsOf), 'type').map((a) => ({ type: a.type, usd: a.usd, tokens: a.tokens })),
        prompts: this.promptModels(f).get(m.model) || 0,
      };
    });
  }

  /** Daily usd per model, for the stacked "cost by model over time" chart. */
  modelSeries(f = {}) {
    const to = f.to || today();
    const from = f.from || addDays(to, -29);
    const sel = this.select({ ...f, from, to });
    const models = rank(groupBy(sel.usage, (r) => r.model, totalsOf), 'model').map((m) => m.model);
    const cell = groupBy(sel.usage, (r) => `${r.day}|${r.model}`, totalsOf);
    return {
      models,
      days: dayRange(from, to).map((day) => ({ day, ...Object.fromEntries(models.map((m) => [m, (cell.get(`${day}|${m}`) || { usd: 0 }).usd])) })),
    };
  }

  agents(f = {}) {
    const sel = this.select(f);
    const byType = rank(groupBy(sel.usage, (r) => r.type, totalsOf), 'type').map((t) => {
      const rows = sel.usage.filter((r) => r.type === t.type);
      const ids = new Set(rows.filter((r) => !r.rolled && r.agent !== 'main').map((r) => r.agent));
      const rolledAgents = rows.filter((r) => r.rolled).reduce((s, r) => s + r.agents, 0);
      return { ...t, agents: t.type === 'main' ? 0 : ids.size + rolledAgents, sessions: new Set(rows.map((r) => r.session).filter(Boolean)).size };
    });
    const sessions = [...groupBy(sel.usage.filter((r) => r.session), (r) => r.session, (rows) => rows)]
      .map(([session, rows]) => {
        const main = totalsOf(rows.filter((r) => r.type === 'main'));
        const sub = totalsOf(rows.filter((r) => r.type !== 'main'));
        return {
          session,
          dev: rows[0].dev,
          name: this.name(rows[0].dev),
          day: rows[0].day,
          task: rows.map((r) => r.task).find(Boolean) || null,
          mainUsd: main.usd,
          subUsd: sub.usd,
          mainTokens: main.tokens,
          subTokens: sub.tokens,
          agents: new Set(rows.filter((r) => r.type !== 'main').map((r) => r.agent)).size,
          overhead: main.usd + sub.usd ? round(sub.usd / (main.usd + sub.usd)) : 0,
        };
      })
      .filter((s) => s.agents > 0)
      .sort((a, b) => b.subUsd - a.subUsd);
    const total = totalsOf(sel.usage);
    const sub = totalsOf(sel.usage.filter((r) => r.type !== 'main'));
    return { byType, sessions: sessions.slice(0, 100), overhead: total.usd ? round(sub.usd / total.usd) : 0, totalSessionsWithAgents: sessions.length };
  }

  tasks(f = {}) {
    const sel = this.select(f);
    const promptsPerTask = countBy(sel.prompts, (r) => r.task);
    const meta = new Map();
    for (const t of this.all.tasks) {
      if (!t.task) continue;
      const m = meta.get(t.task) || {};
      if (t.title && !m.title) m.title = t.title;
      if (t.status === 'done') m.status = 'done';
      else if (!m.status && (t.status === 'created' || t.status === 'set')) m.status = 'open';
      meta.set(t.task, m);
    }
    const rows = [...groupBy(sel.usage, (r) => r.task || '(none)', (rs) => rs)].map(([task, rs]) => {
      const t = totalsOf(rs);
      return {
        task,
        ...t,
        prompts: promptsPerTask.get(task === '(none)' ? null : task) || 0,
        models: rank(groupBy(rs, (r) => r.model, totalsOf), 'model').map((m) => ({ model: m.model, usd: m.usd, tokens: m.tokens })),
        devs: [...new Set(rs.map((r) => r.dev))].map((d) => ({ dev: d, name: this.name(d) })),
        branches: [...new Set(rs.map((r) => r.branch).filter(Boolean))],
        sessions: new Set(rs.map((r) => r.session).filter(Boolean)).size,
        first: rs[0].ts,
        last: rs[rs.length - 1].ts,
        durMs: rs.reduce((s, r) => s + r.dur, 0),
        title: (meta.get(task) || {}).title || null,
        status: (meta.get(task) || {}).status || null,
      };
    });
    const branches = rank(groupBy(sel.usage.filter((r) => r.branch), (r) => r.branch, totalsOf), 'branch');
    return { tasks: rows.sort((a, b) => b.usd - a.usd || b.tokens - a.tokens), branches };
  }

  /** Map model -> prompts answered by it (a prompt is attributed to the next main turn of its session). */
  promptModels(f = {}) {
    const sel = this.select({ ...f, model: undefined, agent: undefined });
    const counts = new Map();
    for (const p of sel.prompts) {
      const m = p.model || this.answeringModel(p);
      if (m) counts.set(m, (counts.get(m) || 0) + p.n);
    }
    return counts;
  }

  answeringModel(p) {
    if (!p.session || !p.ts) return null;
    if (!this._turnsBySession) {
      this._turnsBySession = new Map();
      for (const r of this.all.usage) {
        if (r.type !== 'main' || !r.session) continue;
        if (!this._turnsBySession.has(r.session)) this._turnsBySession.set(r.session, []);
        this._turnsBySession.get(r.session).push(r);
      }
    }
    const rows = this._turnsBySession.get(p.session);
    if (!rows) return null;
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].ts < p.ts) lo = mid + 1;
      else hi = mid;
    }
    return rows[lo] ? rows[lo].model : null;
  }

  /** Searchable prompt log, newest first. q matches text (case-insensitive) or a hash prefix. */
  promptLog(f = {}) {
    const sel = this.select({ ...f, model: undefined, agent: undefined });
    const q = (f.q || '').trim().toLowerCase();
    let items = sel.prompts.filter((p) => !p.rolled);
    if (q) items = items.filter((p) => (p.text && p.text.toLowerCase().includes(q)) || (p.hash && p.hash.startsWith(q)) || (p.task && p.task.toLowerCase() === q));
    items = items.map((p) => ({ ...p, model: this.answeringModel(p), name: this.name(p.dev) }));
    if (f.model) items = items.filter((p) => p.model === f.model);
    const total = items.length;
    items = items.reverse().slice(0, f.limit || 500);
    const perTask = [...countBy(sel.prompts, (p) => p.task || '(none)')].map(([task, n]) => ({ task, n })).sort((a, b) => b.n - a.n);
    const perModel = [...this.promptModels(f)].map(([model, n]) => ({ model, n })).sort((a, b) => b.n - a.n);
    return { total, items, perTask, perModel, rolled: sel.prompts.filter((p) => p.rolled).reduce((s, p) => s + p.n, 0) };
  }

  name(dev) {
    const d = this.names[dev];
    return (d && (typeof d === 'string' ? d : d.name)) || dev;
  }
}

// ---------------------------------------------------------------- helpers

/** The top tier of each vendor's lineup: what "spend on the frontier model" means in the developer profile. */
function isFrontier(model) {
  return /opus|fable|mythos/i.test(String(model || ''));
}

function reprice(table, r) {
  const perReq = r.req ? Math.round((r.in + r.cw + r.cr) / r.req) : undefined;
  const usd = cost(table, r.model, r, r.speed, perReq);
  return usd == null ? null : usd;
}

function totalsOf(rows) {
  const t = { in: 0, out: 0, cw: 0, cr: 0, tokens: 0, usd: 0, req: 0, turns: 0, durMs: 0, unpricedTokens: 0 };
  for (const r of rows) {
    t.in += r.in;
    t.out += r.out;
    t.cw += r.cw;
    t.cr += r.cr;
    t.req += r.req;
    t.turns += r.turns;
    t.durMs += r.dur;
    const tok = r.in + r.out + r.cw + r.cr;
    t.tokens += tok;
    if (r.usd == null) t.unpricedTokens += tok;
    else t.usd += r.usd;
  }
  t.usd = round(t.usd);
  return t;
}

function pickTotals(t) {
  t = t || totalsOf([]);
  return { tokens: t.tokens, usd: t.usd, in: t.in, out: t.out, cw: t.cw, cr: t.cr };
}

function activity(sel) {
  const ids = new Set();
  let rolledSessions = 0;
  for (const s of sel.sessions) {
    if (s.rolled) rolledSessions += s.n;
    else if (s.session) ids.add(s.session);
  }
  for (const r of sel.usage) if (r.session) ids.add(r.session);
  return { sessions: ids.size + rolledSessions, prompts: sel.prompts.reduce((s, p) => s + p.n, 0) };
}

function filterDev(sel, dev) {
  return {
    usage: sel.usage.filter((r) => r.dev === dev),
    prompts: sel.prompts.filter((r) => r.dev === dev),
    sessions: sel.sessions.filter((r) => r.dev === dev),
    tasks: sel.tasks.filter((r) => r.dev === dev),
  };
}

function groupBy(rows, keyFn, reduce) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [k, v] of groups) groups.set(k, reduce(v));
  return groups;
}

function countBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) m.set(keyFn(r), (m.get(keyFn(r)) || 0) + (r.n || 1));
  return m;
}

function rank(groups, key) {
  return [...groups].map(([k, t]) => ({ [key]: k, ...t })).sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
}

// ---------------------------------------------------------------- CSV

function toCsv(rows, columns) {
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

module.exports = { Dataset, normalize, dayOf, addDays, today, weekStart, dayRange, totalsOf, toCsv };
