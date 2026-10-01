// Obfuscation and restoration of strings and of whole JSON values (tool inputs and outputs), keeping their shape.
'use strict';

const Engine = require('./obfuscator.js');

const MAX_STRING = 5 * 1024 * 1024; // larger strings are left alone (binary dumps, huge logs)
const SKIP_KEYS = new Set(['base64']); // image data in Read results
const TOKEN_RE = /\[([A-Z][A-Z0-9_]*_\d+)\]/g;

// Replaces sensitive values with placeholders from the vault. Returns { text, labels } where labels counts
// replacements per label ({ EMAIL: 2 }).
function obfuscateText(text, settings, vault, labels = {}) {
  if (typeof text !== 'string' || !text || text.length > MAX_STRING) return { text, labels };
  const matches = Engine.findAll(text, settings);
  if (!matches.length) return { text, labels };
  let out = '';
  let pos = 0;
  for (const m of matches) {
    const label = Engine.labelFor(m.rule);
    const repl = m.rule.replacement || vault.tokenFor(label, m.value);
    out += text.slice(pos, m.start) + repl;
    pos = m.end;
    labels[label] = (labels[label] || 0) + 1;
  }
  return { text: out + text.slice(pos), labels };
}

// Sensitive matches without changing anything: { EMAIL: 1, NAME: 2 }.
function scan(text, settings) {
  const labels = {};
  if (typeof text !== 'string' || !text || text.length > MAX_STRING) return labels;
  for (const m of Engine.findAll(text, settings)) {
    const label = Engine.labelFor(m.rule);
    labels[label] = (labels[label] || 0) + 1;
  }
  return labels;
}

// Placeholders known to the vault -> original values. Only the bracketed form is restored, so identifiers such
// as EMAIL_1 in code are never touched. Returns { text, tokens } with the placeholders that were restored.
function restoreText(text, vault, tokens = new Set()) {
  if (typeof text !== 'string' || !text.includes('[')) return { text, tokens };
  TOKEN_RE.lastIndex = 0;
  const out = text.replace(TOKEN_RE, (all) => {
    const value = vault.valueOf(all);
    if (value === undefined) return all;
    tokens.add(all);
    return value;
  });
  return { text: out, tokens };
}

// Applies fn to every string inside a JSON value. Returns the same object when nothing changed.
function mapStrings(value, fn, key) {
  if (typeof value === 'string') return SKIP_KEYS.has(key) ? value : fn(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = mapStrings(v, fn);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? out : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const r = mapStrings(v, fn, k);
      if (r !== v) changed = true;
      out[k] = r;
    }
    return changed ? out : value;
  }
  return value;
}

function obfuscateDeep(value, settings, vault) {
  const labels = {};
  const out = mapStrings(value, (s) => obfuscateText(s, settings, vault, labels).text);
  return { value: out, labels, changed: out !== value };
}

function restoreDeep(value, vault) {
  const tokens = new Set();
  const out = mapStrings(value, (s) => restoreText(s, vault, tokens).text);
  return { value: out, tokens, changed: out !== value };
}

function scanDeep(value, settings) {
  const labels = {};
  mapStrings(value, (s) => {
    for (const [l, n] of Object.entries(scan(s, settings))) labels[l] = (labels[l] || 0) + n;
    return s;
  });
  return labels;
}

// { EMAIL: 2, NAME: 1 } -> "Email ×2, Name"
function describe(labels) {
  return Object.entries(labels)
    .map(([l, n]) => {
      const name = l.charAt(0) + l.slice(1).toLowerCase().replace(/_/g, ' ');
      return n > 1 ? `${name} ×${n}` : name;
    })
    .join(', ');
}

module.exports = { obfuscateText, scan, restoreText, mapStrings, obfuscateDeep, restoreDeep, scanDeep, describe, TOKEN_RE };
