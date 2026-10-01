// Settings: defaults, the user's settings file, word lists and memory.
// Same rule, memory and allowlist format as the Trellis browser extension, so its exported settings can be
// imported as they are (/trellis:import).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Engine = require('./obfuscator.js');

const ROOT = path.join(__dirname, '..');

const DEFAULTS = {
  enabled: true,
  // Prompts with sensitive data: 'block' (never sent; an obfuscated version is offered) | 'warn' | 'off'.
  prompt: 'block',
  // Tool results (file contents, command output, search results...) are obfuscated before Claude sees them.
  toolOutput: true,
  // Word lists (names, surnames) also apply to tool results. Turn off if they cause too much noise in code.
  wordlistsInToolOutput: true,
  // Placeholders in the inputs of local tools (Bash, Read, Edit, Write...) are replaced by the originals,
  // so edits and commands work on the real files.
  restoreLocalTools: true,
  // Shell commands that would get original values and look able to reach the network: 'ask' | 'allow'.
  networkCommands: 'ask',
  // Tools that send data to third parties (WebFetch, WebSearch, MCP servers) with sensitive values in their
  // input: 'deny' | 'ask' | 'allow'. Placeholders are never restored for them.
  outbound: 'deny',
  // MCP servers that run locally and may receive original values (restored like local tools). ["sqlite"]
  localMcpServers: [],
  // Show the original values instead of placeholders in Claude's replies, on your screen only.
  restoreDisplay: true,
  // Warn at session start when CLAUDE.md files (sent without passing through any hook) contain sensitive data.
  checkClaudeMd: true,
  // Same meaning as in the browser extension.
  memory: [],
  allowlist: [],
  exceptionsExtra: '',
  wordlists: [
    { id: 'first-names', name: 'Name', file: 'wordlists/first-names.txt', enabled: true, capitalizedOnly: true },
    { id: 'surnames', name: 'Surname', file: 'wordlists/surnames.txt', enabled: true, capitalizedOnly: true }
  ],
  exceptionsFile: 'wordlists/exceptions.txt',
  rules: [
    {
      id: 'private-key',
      name: 'Private key',
      type: 'regex',
      pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]+?-----END [A-Z ]*PRIVATE KEY-----',
      flags: 'g',
      replacement: '',
      enabled: true
    },
    {
      id: 'jwt',
      name: 'JWT',
      type: 'regex',
      pattern: '\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+',
      flags: 'g',
      replacement: '',
      enabled: true
    },
    {
      id: 'api-key',
      name: 'API key',
      type: 'regex',
      pattern: '\\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})',
      flags: 'g',
      replacement: '',
      enabled: true
    },
    {
      id: 'secret-assign',
      name: 'Secret',
      type: 'regex',
      // Only the value after "password=", "token: ", etc.
      pattern: '(?<=\\b(?:password|passwd|pwd|passwort|contraseña|mot de passe|secret|token|api[_-]?key)\\s*[:=]\\s*["\']?)[^\\s"\',;]+',
      flags: 'gi',
      replacement: '',
      enabled: true
    },
    {
      id: 'email',
      name: 'Email',
      type: 'regex',
      pattern: '(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\\.){1,8}[A-Za-z]{2,24}(?![A-Za-z0-9-])',
      flags: 'g',
      replacement: '',
      enabled: true
    },
    {
      id: 'iban',
      name: 'IBAN',
      type: 'regex',
      pattern: '\\b[A-Z]{2}\\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\\b',
      flags: 'g',
      replacement: '',
      enabled: true
    },
    {
      id: 'card',
      name: 'Card',
      type: 'regex',
      pattern: '\\b(?:\\d{4}[ -]?){3}\\d{4}\\b',
      flags: 'g',
      replacement: '',
      enabled: true
    },
    {
      // Spanish national ID (DNI/NIE)
      id: 'dni-es',
      name: 'National ID',
      type: 'regex',
      pattern: '\\b[XYZ]?\\d{7,8}[- ]?[TRWAGMYFPDXBNJZSQVHLCKE]\\b',
      flags: 'gi',
      replacement: '',
      enabled: true
    },
    {
      // Spanish phone numbers; add your own country's format as a new rule
      id: 'phone-es',
      name: 'Phone',
      type: 'regex',
      pattern: '(?:\\+34[ -]?)?\\b[6789]\\d{2}[ -]?\\d{3}[ -]?\\d{3}\\b',
      flags: 'g',
      replacement: '',
      enabled: true
    },
    {
      id: 'ipv4',
      name: 'IPv4',
      type: 'regex',
      pattern: '\\b(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\b',
      flags: 'g',
      replacement: '',
      enabled: true
    }
  ]
};

// Where settings and vaults live: $TRELLIS_HOME, else the plugin's data directory (kept across plugin updates),
// else ~/.claude/trellis.
function dataDir() {
  return process.env.TRELLIS_HOME || process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'trellis');
}

function settingsPath() {
  return path.join(dataDir(), 'settings.json');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

// Writes a file only the user can read, atomically (no half-written file if two hooks race).
function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Only the keys the user stored; defaults are applied by load().
function loadStored() {
  const stored = readJson(settingsPath(), {});
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

function saveStored(stored) {
  writePrivate(settingsPath(), JSON.stringify(stored, null, 2) + '\n');
}

function merge(stored) {
  const settings = { ...structuredClone(DEFAULTS), ...stored };
  // Values of the wrong type (a hand-edited file) fall back to the defaults.
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (Array.isArray(value) ? !Array.isArray(settings[key]) : typeof settings[key] !== typeof value) settings[key] = structuredClone(value);
  }
  // Stored word lists only switch the bundled ones on or off (their files always come from the plugin).
  if (Array.isArray(stored.wordlists)) {
    settings.wordlists = DEFAULTS.wordlists.map((l) => {
      const s = stored.wordlists.find((x) => x && x.id === l.id);
      return s && typeof s.enabled === 'boolean' ? { ...l, enabled: s.enabled } : { ...l };
    });
  }
  settings.mode = 'placeholder';
  return settings;
}

function parseWordlist(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function readBundled(file) {
  if (!file) return '';
  try {
    return fs.readFileSync(path.join(ROOT, file), 'utf8');
  } catch (e) {
    return '';
  }
}

// Memory first (ignores exceptions: what you store there is always obfuscated), then the bundled lists.
function compileWordlists(settings, { includeBundled = true } = {}) {
  const compiledWordlists = [];
  const groups = new Map();
  for (const m of settings.memory || []) {
    if (!m || typeof m.term !== 'string' || !m.term.trim()) continue;
    const cat = m.category || 'Other';
    const key = cat + (m.partial ? '\u0000partial' : '');
    if (!groups.has(key)) groups.set(key, { cat, partial: !!m.partial, words: [] });
    groups.get(key).words.push(m.term);
  }
  for (const { cat, partial, words } of groups.values()) {
    compiledWordlists.push({ id: 'mem:' + cat + (partial ? ':partial' : ''), name: cat, capitalizedOnly: false, ignoreExceptions: true, partial, words });
  }
  if (includeBundled) {
    for (const l of settings.wordlists || []) {
      if (!l.enabled) continue;
      compiledWordlists.push({ id: l.id, name: l.name, capitalizedOnly: !!l.capitalizedOnly, words: parseWordlist(readBundled(l.file)) });
    }
  }
  const compiledExceptions = [...parseWordlist(readBundled(settings.exceptionsFile)), ...parseWordlist(settings.exceptionsExtra)];
  return { compiledWordlists, compiledExceptions };
}

// Settings ready for the engine. `scope` 'tool' leaves the bundled word lists out when wordlistsInToolOutput
// is off; memory and rules always apply.
function load(scope = 'prompt') {
  const settings = merge(loadStored());
  const includeBundled = scope !== 'tool' || settings.wordlistsInToolOutput !== false;
  return { ...settings, ...compileWordlists(settings, { includeBundled }) };
}

// Keeps only the known fields of a rule, with the right types (imported settings files are untrusted input).
function sanitizeRule(r) {
  if (!r || typeof r !== 'object' || typeof r.pattern !== 'string') return null;
  const rule = {
    id: typeof r.id === 'string' ? r.id.slice(0, 64) : '',
    name: typeof r.name === 'string' ? r.name.slice(0, 64) : 'Rule',
    type: r.type === 'keyword' ? 'keyword' : 'regex',
    pattern: r.pattern.slice(0, 5000),
    replacement: typeof r.replacement === 'string' ? r.replacement.slice(0, 200) : '',
    enabled: r.enabled !== false
  };
  if (rule.type === 'keyword') rule.wholeWord = r.wholeWord !== false;
  else rule.flags = typeof r.flags === 'string' ? r.flags.replace(/[^dgimsuvy]/g, '') : 'gi';
  if (Engine.validateRule(rule)) return null;
  return rule;
}

// Adds terms to memory (no duplicates; case/accent-insensitive). Returns how many were added or changed.
function addToMemory(stored, terms, category, { partial = false } = {}) {
  const memory = Array.isArray(stored.memory) ? stored.memory : [];
  const byKey = new Map(memory.map((m) => [Engine.normalizeTerm(m.term), m]));
  const cat = category || 'Other';
  let changed = 0;
  for (const raw of terms) {
    const term = String(raw || '').replace(/\s+/g, ' ').trim();
    const key = Engine.normalizeTerm(term);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      if (existing.category === cat && (existing.partial || !partial)) continue;
      existing.category = cat;
      if (partial) existing.partial = true;
    } else {
      const entry = { term, category: cat };
      if (partial) entry.partial = true;
      memory.push(entry);
      byKey.set(key, entry);
    }
    changed++;
  }
  stored.memory = memory;
  return changed;
}

module.exports = {
  DEFAULTS,
  ROOT,
  dataDir,
  settingsPath,
  readJson,
  writePrivate,
  loadStored,
  saveStored,
  merge,
  load,
  parseWordlist,
  compileWordlists,
  sanitizeRule,
  addToMemory
};
