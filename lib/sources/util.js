'use strict';
// Shared helpers for the session readers.

const fs = require('fs');
const path = require('path');
const ta = require('../transcript-adapter');

/** Directory entries, [] when missing. */
function dir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Call fn(record, byteOffset) for every complete JSON line after `offset`.
 * Returns { offset, reset } — reset when the file shrank (rewritten) and was read from 0.
 */
function eachLine(file, offset, fn) {
  let at = offset || 0;
  let reset = false;
  for (;;) {
    const inc = ta.readIncrement(file, at);
    if (!inc || !inc.text) {
      if (inc && inc.reset) {
        reset = true;
        at = 0;
      }
      break;
    }
    if (inc.reset) reset = true;
    let pos = inc.end - Buffer.byteLength(inc.text);
    for (const line of inc.text.split('\n')) {
      const start = pos;
      pos += Buffer.byteLength(line) + 1;
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o && typeof o === 'object') fn(o, start);
    }
    at = inc.end;
  }
  return { offset: at, reset };
}

/** { key, file, mtimeMs, size } for a session file. */
function fileEntry(file, key) {
  const st = fs.statSync(file);
  return { key: key || path.basename(file).replace(/\.jsonl?$/, ''), file, mtimeMs: st.mtimeMs, size: st.size };
}

/** Plain text of a Gemini-style Content / parts array / string. */
function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(textOf).filter(Boolean).join('\n');
  if (c && typeof c === 'object') {
    if (typeof c.text === 'string' && !c.thought) return c.text;
    if (Array.isArray(c.parts)) return textOf(c.parts);
  }
  return '';
}

const iso = (t) => {
  if (t == null || t === '') return null;
  const d = typeof t === 'number' || /^\d+$/.test(t) ? new Date(Number(t) < 1e12 ? Number(t) * 1000 : Number(t)) : new Date(t);
  return isNaN(d) ? null : d.toISOString();
};

module.exports = { dir, readJson, eachLine, fileEntry, textOf, iso };
