#!/usr/bin/env node
// Helper for the Trellis mod (hooks/prompt-mod.js). Mods have no Node.js APIs, so the mod runs this script with
// $.process.run and JSON on stdin.
//
//   submit:  { mode: "submit", text, root, cwd, sessionId } -> { text, summary } | { skip: reason }
//            Obfuscates the prompt with the project's vault, leaving @mentions of files as they are (they must
//            still resolve). Leaves a mark (the hash of the text it returned) so the UserPromptSubmit hook knows
//            this exact prompt was already handled and does not block it.
//   mention: { mode: "mention", path, root, cwd } -> { path } (an obfuscated copy) | { keep: true } | { deny: reason }
//
// The data directory comes from the pointer the hooks leave (see lib/settings.js), since a process started by a
// mod does not get CLAUDE_PLUGIN_DATA.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('../lib/settings.js');
const Vault = require('../lib/vault.js');
const R = require('../lib/redact.js');
const Commands = require('../lib/commands.js');
const ProxyState = require('../lib/proxy-state.js');
const Engine = require('../lib/obfuscator.js');

const MAX_MENTION = 5 * 1024 * 1024;
const SOURCE_FILE = '.source';
const MENTION_RE = /(^|\s)@(?:"[^"]+"|[^\s"]+)/g;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const marksDir = () => path.join(S.dataDir(), 'mod-marks');

// The text with every @mention of an existing file left out of obfuscation.
function obfuscateKeepingMentions(text, settings, vault, cwd) {
  const labels = {};
  let out = '';
  let pos = 0;
  MENTION_RE.lastIndex = 0;
  let m;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const start = m.index + m[1].length;
    const raw = text.slice(start + 1, m.index + m[0].length).replace(/^"|"$/g, '');
    const target = raw.replace(/#L?\d+(?:-\d+)?$/, '').replace(/[),.;:]+$/, '');
    let isFile = false;
    try {
      isFile = fs.statSync(path.resolve(cwd, target)).isFile();
    } catch (e) {
      // not a file
    }
    if (!isFile) continue;
    out += R.obfuscateText(text.slice(pos, start), settings, vault, labels).text + text.slice(start, m.index + m[0].length);
    pos = m.index + m[0].length;
  }
  out += R.obfuscateText(text.slice(pos), settings, vault, labels).text;
  return { text: out, labels };
}

function mark(sessionId, text) {
  const dir = marksDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Old marks are of no use: prune what is older than a day.
  for (const f of fs.readdirSync(dir)) {
    try {
      if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 86400000) fs.rmSync(path.join(dir, f), { force: true });
    } catch (e) {
      // removed meanwhile
    }
  }
  S.writePrivate(path.join(dir, sha(String(sessionId || 'none')).slice(0, 32)), sha(text));
}

// Paths of obfuscated copies in a string, replaced by the files they were made from.
function toOriginals(text) {
  if (typeof text !== 'string' || !text.includes('mentions')) return text;
  const base = path.join(S.dataDir(), 'mentions') + path.sep;
  const re = new RegExp(Engine.escapeRegex(base) + '([0-9a-f]{16})' + Engine.escapeRegex(path.sep) + '([^\\s"\'\\\\]+)', 'g');
  return text.replace(re, (all, hash) => {
    try {
      return fs.readFileSync(path.join(base, hash, SOURCE_FILE), 'utf8') || all;
    } catch (e) {
      return all;
    }
  });
}

// Whether the UserPromptSubmit hook got exactly the text the mod produced for this session.
function wasHandled(sessionId, text) {
  try {
    return fs.readFileSync(path.join(marksDir(), sha(String(sessionId || 'none')).slice(0, 32)), 'utf8') === sha(text);
  } catch (e) {
    return false;
  }
}

function submit(input) {
  const text = String(input.text || '');
  const settings = S.load('prompt');
  if (!settings.enabled) return { skip: 'disabled' };
  if (settings.prompt !== 'rewrite') return { skip: `prompt mode ${settings.prompt}` };
  if (Commands.parse(text)) return { skip: 'a Trellis command' };
  if (ProxyState.active()) return { skip: 'proxy mode' };
  const cwd = input.cwd || input.root || process.cwd();
  const result = Vault.update(input.root || cwd, (vault) => obfuscateKeepingMentions(text, settings, vault, cwd));
  mark(input.sessionId, result.text);
  return { text: result.text, summary: R.describe(result.labels) };
}

function mention(input) {
  const settings = S.load('prompt');
  if (!settings.enabled || settings.prompt !== 'rewrite' || ProxyState.active()) return { keep: true };
  const file = path.resolve(input.cwd || input.root || process.cwd(), String(input.path || ''));
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return { keep: true }; // not a file Trellis can read: Claude Code decides
  }
  if (!st.isFile()) return { keep: true };
  if (st.size > MAX_MENTION) return { deny: 'Trellis: this file is too large to check for sensitive data; ask Claude to read it instead.' };
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) return { keep: true }; // binary (images, PDFs): not text Trellis can obfuscate
  const text = buf.toString('utf8');
  const result = Vault.update(input.root || path.dirname(file), (vault) => R.obfuscateText(text, settings, vault));
  if (result.text === text) return { keep: true };
  // An obfuscated copy, named after the original so the attachment reads naturally.
  const dir = path.join(S.dataDir(), 'mentions', sha(file).slice(0, 16));
  const copy = path.join(dir, path.basename(file));
  S.writePrivate(copy, result.text);
  S.writePrivate(path.join(dir, SOURCE_FILE), file); // so tools aimed at the copy can be sent to the original
  return { path: copy, original: file, summary: R.describe(result.labels) };
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (e) {
    process.stdout.write(JSON.stringify({ skip: 'invalid input' }));
    process.exit(2);
  }
  const out = input.mode === 'mention' ? mention(input) : submit(input);
  process.stdout.write(JSON.stringify(out));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`Trellis: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { submit, mention, wasHandled, obfuscateKeepingMentions, toOriginals };
