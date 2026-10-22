'use strict';
// Cost estimation. Prices are API-equivalent list prices (USD per million
// tokens): the team is on subscriptions, so these are estimates for
// comparison and budgeting, never a bill.

const fs = require('fs');
const path = require('path');

const BUILTIN = path.join(__dirname, '..', 'templates', 'pricing.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Plugin defaults overlaid with the repo's editable .tokentaby/pricing.json. */
function loadPricing(repoRoot) {
  const base = readJson(BUILTIN) || {};
  const repo = repoRoot ? readJson(path.join(repoRoot, '.tokentaby', 'pricing.json')) : null;
  return compile(base, repo || {});
}

function compile(base, over) {
  return {
    version: over.version || base.version || null,
    currency: over.currency || base.currency || 'USD',
    defaults: { ...base.defaults, ...over.defaults },
    fx: { USD: 1, ...base.fx, ...over.fx },
    models: { ...base.models, ...over.models },
    aliases: { ...base.aliases, ...over.aliases },
  };
}

/**
 * Canonical model id: strips provider prefixes (Bedrock "us.anthropic.",
 * "anthropic/"), Vertex "@date", Bedrock "-v1:0", "[1m]" context tags and
 * dated snapshot suffixes.
 */
function normalizeModel(id) {
  return String(id || '')
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^(?:[a-z]+\.)?anthropic[./]/, '')
    .replace(/@.*$/, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/-\d{8}$/, '')
    // Copilot / OpenRouter spell Claude versions with dots: claude-sonnet-4.5
    .replace(/^(claude-[a-z]+-\d+)\.(\d+)/, '$1-$2');
}

/** Price entry for a model id, or null when the model is unknown. */
function lookup(table, model) {
  const m = normalizeModel(model);
  if (!m || m === '<synthetic>') return null;
  const key = table.aliases[m] || m;
  if (table.models[key]) return { key, ...table.models[key] };
  // a variant of a known model (e.g. "claude-opus-5-5-fast"): longest key on a "-" boundary
  let best = null;
  for (const k of Object.keys(table.models)) {
    if (m.startsWith(k + '-') && (!best || k.length > best.length)) best = k;
  }
  return best ? { key: best, ...table.models[best] } : null;
}

/**
 * Estimated USD for one API request's tokens.
 * u: { in, out, cw, cr, cw1h, ws }; cw includes cw1h (the 1-hour-TTL share).
 * promptTokens decides long-context tiers; it defaults to this request's own
 * prompt but callers pricing a usage delta pass the full request's size.
 * Returns null for unpriced models so they are reported, not silently free.
 */
function cost(table, model, u, speed, promptTokens) {
  const p = lookup(table, model);
  if (!p) return null;
  const d = table.defaults;
  const tin = u.in || 0;
  const tcw = u.cw || 0;
  const tcr = u.cr || 0;
  const prompt = promptTokens != null ? promptTokens : tin + tcw + tcr;
  let r = p.long && prompt > p.long.threshold ? { ...p, ...p.long } : p;
  // size tiers (Qwen): the highest tier the request's prompt reaches prices the whole request
  for (const t of p.tiers || []) if (prompt > t.threshold) r = { ...p, ...t };
  const cw1h = Math.min(u.cw1h || 0, tcw);
  let usd =
    (tin * r.input +
      (u.out || 0) * r.output +
      (tcw - cw1h) * (r.cache_write_5m != null ? r.cache_write_5m : r.cache_write != null ? r.cache_write : r.input * d.cache_write_5m_mult) +
      cw1h * (r.cache_write_1h != null ? r.cache_write_1h : r.input * d.cache_write_1h_mult) +
      tcr * (r.cache_read != null ? r.cache_read : r.input * d.cache_read_mult)) /
    1e6;
  if (speed === 'fast') usd *= p.fast != null ? p.fast : d.fast_mult;
  usd += ((u.ws || 0) * (d.web_search_per_1k || 0)) / 1000;
  return round(usd);
}

function round(usd) {
  return Math.round(usd * 1e6) / 1e6;
}

module.exports = { loadPricing, normalizeModel, lookup, cost, round, compile };
