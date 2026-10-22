'use strict';
// Offline dashboard: one self-contained HTML file carrying the data plus the
// same aggregation code the server runs (pricing, aggregate, api), so it opens
// from disk with no server and stays fully interactive — filters, tables,
// CSV/JSON export. It embeds every event, logged prompt text included: share
// it the way you would share the repo itself.

const fs = require('fs');
const path = require('path');
const { openDataset, metaFor } = require('./server');

const DASHBOARD = path.join(__dirname, '..', 'dashboard', 'index.html');
const MODULES = ['./pricing', './tools', './aggregate', './api'];

/** The lib modules wrapped in a tiny CommonJS loader (fs/path stubbed: never used client-side). */
function bundle() {
  const defs = MODULES.map((name) => {
    const src = fs.readFileSync(path.join(__dirname, `${name.slice(2)}.js`), 'utf8');
    return `${JSON.stringify(name)}: function (module, exports, require, __dirname) {\n${src}\n}`;
  });
  return `(function () {
  var defs = {${defs.join(',\n')}};
  var cache = {};
  var stubs = { fs: {}, path: { join: function () { return ''; } } };
  function req(name) {
    if (stubs[name]) return stubs[name];
    if (!cache[name]) {
      var m = { exports: {} };
      cache[name] = m;
      defs[name](m, m.exports, req, '');
    }
    return cache[name].exports;
  }
  window.tokentabyRequire = req;
})();`;
}

// Answers the dashboard's api() calls in the page instead of over HTTP.
const LOCAL_API = `(function () {
  var S = window.TOKENTABY_SNAPSHOT;
  var agg = window.tokentabyRequire('./aggregate');
  var api = window.tokentabyRequire('./api');
  var ds = new agg.Dataset(S.events, { me: S.me, pricing: S.pricing, names: S.names });
  ds.cfg = S.cfg;
  function local(path, params) {
    if (path === '/api/meta') return Promise.resolve(S.meta);
    var body = api.view(ds, path, api.filtersFrom(params || {}));
    return body === undefined ? Promise.reject(new Error('not available in a snapshot')) : Promise.resolve(body);
  }
  local.exportFile = function (kind, format, params) {
    return api.exportFile(ds, S.events, kind, format, api.filtersFrom(params || {}));
  };
  window.tokentabyLocal = local;
})();`;

// U+2028/U+2029 end a line inside <script> source; built from char codes so this file never contains them
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);
function escapeSeparators(s) {
  return s.split(LINE_SEP).join('\\u' + '2028').split(PARA_SEP).join('\\u' + '2029');
}

/** Safe inside a <script> element: no "</script", no raw line separators. */
function scriptSafe(s) {
  return escapeSeparators(s.replace(/<\/(script)/gi, '<\\/$1'));
}

/** opts.noPrompts strips prompt text (hashes and lengths stay), for sharing outside the team. */
function buildSnapshot(repo, opts = {}) {
  const opened = openDataset(repo);
  if (opts.noPrompts) opened.events = opened.events.map((e) => (e.t === 'prompt' && e.text != null ? { ...e, text: undefined } : e));
  const generated = new Date().toISOString();
  const { prompt_mode, sync, currency } = opened.cfg;
  const data = {
    meta: { ...metaFor(repo, opened, { snapshot: { generated } }), ...(opts.noPrompts ? { promptMode: 'hash_only' } : {}) },
    events: opened.events,
    pricing: opened.pricing,
    names: opened.ds.names,
    me: opened.ds.me,
    cfg: { prompt_mode, sync, currency },
  };
  const json = escapeSeparators(JSON.stringify(data).replace(/</g, '\\u003c'));
  const html = fs.readFileSync(DASHBOARD, 'utf8');
  const inject = `<script>window.TOKENTABY_SNAPSHOT = ${json};</script>\n<script>\n${scriptSafe(bundle())}\n${LOCAL_API}\n</script>\n`;
  const at = html.indexOf('<script>');
  return { html: html.slice(0, at) + inject + html.slice(at), events: opened.events.length, generated };
}

module.exports = { buildSnapshot };
