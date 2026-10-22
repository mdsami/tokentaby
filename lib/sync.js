'use strict';
// Git integration: /tokentaby:init, shipping spooled usage (ride-along pre-commit,
// auto-commit on SessionEnd, manual /tokentaby:sync) and the pre-commit secrets
// backstop. tokentaby only ever commits locally: it never pushes, so it never
// uses the developer's git credentials.

const fs = require('fs');
const path = require('path');
const store = require('./store');
const git = require('./git');
const { resolveConfig } = require('./config');
const { scan } = require('./secrets');

const TEMPLATES = path.join(__dirname, '..', 'templates');

/** Create .tokentaby/ (idempotent: existing files are kept) and install the pre-commit hook. */
function init(repo, opts = {}) {
  const created = [];
  const put = (rel, content) => {
    const abs = path.join(repo.root, rel);
    if (fs.existsSync(abs)) return;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    created.push(rel);
  };
  const template = (name) => fs.readFileSync(path.join(TEMPLATES, name), 'utf8');
  put('.tokentaby/schema-version', `${store.SCHEMA_VERSION}\n`);
  put('.tokentaby/.gitattributes', '# append-only logs: union merges never conflict\n*.ndjson merge=union\n');
  put('.tokentaby/pricing.json', template('pricing.json'));
  put(
    '.tokentaby/config.json',
    JSON.stringify({ prompt_mode: opts.promptMode || 'truncated', sync: opts.sync || 'ride-along', truncate_chars: 200 }, null, 2) + '\n'
  );
  put('.tokentaby/devs.json', '{}\n');
  put('.tokentaby/README.md', template('tokentaby-README.md'));
  put('.tokentaby/devs/.gitkeep', '');
  if (opts.ci) put('.github/workflows/tokentaby.yml', template('github-workflow.yml'));
  const hook = git.installPreCommit(repo, { allowTracked: !!opts.allowTrackedHook });
  return { created, hook };
}

/**
 * Secret-pattern hits in the added lines of a unified diff (-U0).
 * Returns [{ file, line, patterns }].
 */
function scanDiff(diff) {
  const hits = [];
  let file = null;
  let line = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) {
      file = l.replace(/^\+\+\+ (b\/)?/, '');
    } else if (l.startsWith('@@')) {
      const m = /\+(\d+)/.exec(l);
      line = m ? parseInt(m[1], 10) : 0;
    } else if (l.startsWith('+')) {
      const patterns = scan(l.slice(1));
      if (patterns.length) hits.push({ file, line, patterns });
      line++;
    }
  }
  return hits;
}

function formatHits(hits) {
  return hits.map((h) => `  ${h.file}:${h.line}  (${h.patterns.join(', ')})`).join('\n');
}

/** Paths to ship for a dev: freshly flushed files plus anything left in their directory. */
function usagePaths(repo, dev, flushed) {
  const paths = new Set(flushed);
  if (dev && fs.existsSync(path.join(repo.root, `.tokentaby/devs/${dev}`))) paths.add(`.tokentaby/devs/${dev}`);
  return [...paths];
}

/**
 * git pre-commit entry. Ride-along mode moves the spool into the dev's
 * monthly log and stages it with the commit; every mode then refuses the
 * commit if a staged usage line looks like it contains a credential.
 * Returns the hook's exit code.
 */
function precommit(cwd, out = process.stderr) {
  const repo = git.findRepo(cwd);
  if (!repo || !store.isInitialized(repo.root)) return 0;
  const state = store.readState(repo);
  const cfg = resolveConfig(repo.root, state.options);
  if (cfg.sync === 'ride-along' && !git.operationInProgress(repo)) {
    // usage from Codex, OpenCode, Gemini CLI, … rides along with this commit too
    require('./importer').autoImport(repo);
    const dev = store.devIdFor(cfg, state);
    const { files } = store.flushSpool(repo);
    const paths = usagePaths(repo, dev, files);
    if (paths.length) git.git(['add', '--', ...paths], repo.root);
  }
  const diff = git.git(['diff', '--cached', '-U0', '--no-color', '--', '.tokentaby/'], repo.root).stdout;
  const hits = scanDiff(diff);
  if (!hits.length) return 0;
  out.write(
    'tokentaby: refusing to commit — logged usage looks like it contains a secret:\n' +
      formatHits(hits) +
      '\nEdit those lines (replace the value with [REDACTED]), re-stage, and commit again.\n'
  );
  return 1;
}

/**
 * Commit the dev's usage as its own commit (auto-commit and manual modes).
 * Only usage paths are committed (--only): the dev's other staged work is
 * left alone. Never pushes. Returns { committed, message?, files?, reason? }.
 */
function commitUsage(repo, opts = {}) {
  const state = store.readState(repo);
  const cfg = resolveConfig(repo.root, state.options);
  const dev = opts.dev || store.devIdFor(cfg, state);
  if (!dev) return { committed: false, reason: 'no developer id yet — set dev_id in /plugin → tokentaby' };
  const op = git.operationInProgress(repo);
  if (op) return { committed: false, reason: `${op} in progress — usage stays queued` };
  if (!git.currentBranch(repo)) return { committed: false, reason: 'detached HEAD — usage stays queued' };
  require('./importer').autoImport(repo, { dev, keepDataDir: !!process.env.CLAUDE_PLUGIN_DATA });
  const { files } = store.flushSpool(repo);
  const paths = usagePaths(repo, dev, files);
  if (!paths.length) return { committed: false, reason: 'nothing to commit' };
  const add = git.git(['add', '--', ...paths], repo.root);
  if (!add.ok) return { committed: false, reason: add.stderr.trim() };
  const staged = git.git(['diff', '--cached', '--name-only', '--', ...paths], repo.root).stdout.trim();
  if (!staged) return { committed: false, reason: 'nothing to commit' };
  const hits = scanDiff(git.git(['diff', '--cached', '-U0', '--no-color', '--', ...paths], repo.root).stdout);
  if (hits.length) return { committed: false, reason: 'possible secrets in logged usage:\n' + formatHits(hits), hits };
  const message = `chore(usage): ${dev} ${new Date().toISOString().slice(0, 10)}`;
  const c = git.git(['commit', '--no-verify', '--only', '-m', message, '--', ...paths], repo.root);
  if (!c.ok) return { committed: false, reason: (c.stderr || c.stdout).trim() };
  return { committed: true, message, files: staged.split('\n') };
}


module.exports = { init, precommit, commitUsage, scanDiff, formatHits };
