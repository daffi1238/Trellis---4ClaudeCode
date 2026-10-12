// /trellis:* commands. They run locally inside the prompt hook, which then blocks the prompt, so their
// arguments (the terms you want to hide) never reach the model. Replies never repeat the terms either.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Engine = require('./obfuscator.js');
const S = require('./settings.js');
const Vault = require('./vault.js');
const R = require('./redact.js');
const ProxyState = require('./proxy-state.js');
const Service = require('./service.js');

const NAMES = ['add', 'allow', 'forget', 'status', 'scan', 'import', 'clear', 'proxy', 'help'];
const PREFIX_RE = new RegExp(`^\\s*/trellis:(${NAMES.join('|')})(?:\\s+([\\s\\S]*))?$`);

// "/trellis:add Northwind --as Company" -> { name: 'add', args: 'Northwind --as Company' }
function parse(prompt) {
  const m = PREFIX_RE.exec(String(prompt || ''));
  return m ? { name: m[1], args: (m[2] || '').trim() } : null;
}

// Splits "--as Company --partial a, b" into options and the comma/newline separated terms.
function parseTerms(args) {
  let rest = ` ${args} `;
  const opts = { partial: false, category: null };
  rest = rest.replace(/\s--partial(?=\s)/g, () => {
    opts.partial = true;
    return ' ';
  });
  rest = rest.replace(/\s--(?:as|category)[ =]("[^"]+"|\S+)(?=\s)/g, (all, cat) => {
    opts.category = cat.replace(/^"|"$/g, '').trim();
    return ' ';
  });
  const terms = rest
    .split(/[,\n;]/)
    .map((t) => t.trim())
    .filter(Boolean);
  return { terms, ...opts };
}

function resolvePath(p, cwd) {
  const clean = String(p || '').trim().replace(/^["']|["']$/g, '').replace(/^~(?=\/|$)/, process.env.HOME || '~');
  return path.resolve(cwd || '.', clean);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const HELP = `Trellis commands (they run on your machine; their arguments are never sent to Claude):
  /trellis:add <term>[, <term>...] [--as <Category>] [--partial]   hide terms (people, companies, projects...)
  /trellis:allow <term>[, ...]       never obfuscate these values (false positives)
  /trellis:forget <term>[, ...]      remove terms from the memory and the allowlist
  /trellis:scan <file>               show what Trellis would hide in a file
  /trellis:import <file>             import settings exported from the Trellis browser extension, or a memory list
  /trellis:clear                     forget this project's placeholders (all of the proxy's, in proxy mode)
  /trellis:proxy                     how to start proxy mode (obfuscates everything sent to the model)
  /trellis:proxy install [--port N] [--upstream URL]   run the proxy as a systemd user service (Linux)
  /trellis:proxy uninstall           remove that service
  /trellis:status                    settings and counts`;

function run(cmd, ctx) {
  const { name, args } = cmd;
  const cwd = ctx.cwd || process.cwd();
  const projectDir = ctx.projectDir || cwd;
  switch (name) {
    case 'add': {
      const { terms, partial, category } = parseTerms(args);
      if (!terms.length) return 'Usage: /trellis:add <term>[, <term>...] [--as <Category>] [--partial]';
      const stored = S.loadStored();
      const n = S.addToMemory(stored, terms, category || 'Other', { partial });
      if (n) S.saveStored(stored);
      return n
        ? `Trellis: ${plural(n, 'term')} added to memory (${category || 'Other'}${partial ? ', partial match' : ''}). ` +
            'They are now obfuscated in your prompts and in what Claude reads.'
        : 'Trellis: already in memory, nothing changed.';
    }
    case 'allow': {
      const { terms } = parseTerms(args);
      if (!terms.length) return 'Usage: /trellis:allow <term>[, <term>...]';
      const stored = S.loadStored();
      const list = Array.isArray(stored.allowlist) ? stored.allowlist : [];
      const have = new Set(list.map(Engine.normalizeTerm));
      const added = terms.filter((t) => !have.has(Engine.normalizeTerm(t)));
      if (added.length) {
        stored.allowlist = [...list, ...added];
        S.saveStored(stored);
      }
      return added.length
        ? `Trellis: ${plural(added.length, 'value')} added to the allowlist; rules and word lists no longer hide them (memory still does).`
        : 'Trellis: already allowed, nothing changed.';
    }
    case 'forget': {
      const { terms } = parseTerms(args);
      if (!terms.length) return 'Usage: /trellis:forget <term>[, <term>...]';
      const keys = new Set(terms.map(Engine.normalizeTerm));
      const stored = S.loadStored();
      const memory = Array.isArray(stored.memory) ? stored.memory : [];
      const allow = Array.isArray(stored.allowlist) ? stored.allowlist : [];
      stored.memory = memory.filter((m) => !keys.has(Engine.normalizeTerm(m.term)));
      stored.allowlist = allow.filter((t) => !keys.has(Engine.normalizeTerm(t)));
      const n = memory.length - stored.memory.length + allow.length - stored.allowlist.length;
      if (n) S.saveStored(stored);
      return n ? `Trellis: ${n} ${n === 1 ? 'entry' : 'entries'} removed.` : 'Trellis: not found, nothing changed.';
    }
    case 'scan': {
      if (!args) return 'Usage: /trellis:scan <file>';
      const file = resolvePath(args, cwd);
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (e) {
        return `Trellis: cannot read ${file} (${e.code || e.message}).`;
      }
      const labels = R.scan(text, S.load('tool'));
      return Object.keys(labels).length
        ? `Trellis: ${path.relative(cwd, file) || file} contains ${R.describe(labels)}. Claude only sees placeholders when it reads it with its tools; do not attach it with @.`
        : `Trellis: nothing sensitive found in ${path.relative(cwd, file) || file}.`;
    }
    case 'import':
      return importFile(resolvePath(args, cwd));
    case 'clear': {
      if (ProxyState.active()) {
        const n = Vault.updateFile(ProxyState.vaultFile(), (v) => {
          const size = v.size;
          v.data = { version: 1, tokens: {}, counters: {} };
          v.dirty = true;
          return size;
        });
        return `Trellis: ${plural(n, 'placeholder')} forgotten by the proxy. Placeholders already in conversations can no longer be restored.`;
      }
      const n = Vault.clear(projectDir);
      return `Trellis: ${plural(n, 'placeholder')} forgotten for this project. Placeholders already in the conversation can no longer be restored.`;
    }
    case 'proxy': {
      const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
      if (sub === 'install') {
        const opts = {};
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--port') opts.port = Number(rest[++i]);
          else if (rest[i] === '--upstream') opts.upstream = rest[++i];
          else return `Trellis: unknown option ${rest[i]}. Usage: /trellis:proxy install [--port N] [--upstream URL]`;
        }
        const r = Service.install(opts);
        if (!r.ok) return r.message;
        return [
          r.message,
          '',
          'Point Claude Code to it, either in your shell profile (~/.bashrc, ~/.zshrc):',
          '',
          `  export ANTHROPIC_BASE_URL=${r.url}`,
          '',
          'or for Claude Code only, in ~/.claude/settings.json:',
          '',
          `  "env": { "ANTHROPIC_BASE_URL": "${r.url}" }`,
          '',
          'New sessions then run in proxy mode; this one does not (the variable is read at start).'
        ].join('\n');
      }
      if (sub === 'uninstall') return Service.uninstall() + ' Remove ANTHROPIC_BASE_URL wherever you set it, or Claude Code cannot reach the model.';
      if (sub) return 'Usage: /trellis:proxy [install [--port N] [--upstream URL] | uninstall]';
      const proxy = ProxyState.active();
      const svc = Service.status();
      const svcLine = svc ? `Service "${Service.NAME}": ${svc.active}, ${svc.enabled} at login (version ${svc.version}).` : null;
      if (proxy) return [`Trellis: this session runs behind the Trellis proxy (${proxy.url} -> ${proxy.upstream}).`, svcLine].filter(Boolean).join('\n');
      const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      if (svc) {
        return [
          svcLine,
          'This session does not use it: start Claude Code with ANTHROPIC_BASE_URL pointing to the proxy (see the install message, or /trellis:help).'
        ].join('\n');
      }
      return [
        'Trellis proxy mode obfuscates everything sent to the model (CLAUDE.md, @ attachments, git status, tool errors included) and restores the replies.',
        'Start it in another terminal (it uses the same settings and memory as this plugin):',
        '',
        `  TRELLIS_HOME=${q(S.dataDir())} node ${q(path.join(S.ROOT, 'scripts', 'proxy.js'))}`,
        '',
        'Then start Claude Code with:',
        '',
        '  ANTHROPIC_BASE_URL=http://127.0.0.1:8788 claude',
        '',
        'Add --upstream <url> to the proxy for another Anthropic-compatible API. The proxy path changes when the plugin updates; run /trellis:proxy again then.',
        '',
        'Or run it as a service that starts with your session and follows plugin updates: /trellis:proxy install'
      ].join('\n');
    }
    case 'status': {
      const s = S.load();
      const stored = S.loadStored();
      const rules = (s.rules || []).filter((r) => r.enabled).length;
      const lists = (s.wordlists || []).filter((l) => l.enabled).map((l) => l.name);
      const proxy = ProxyState.active();
      return [
        `Trellis is ${s.enabled ? 'ON' : 'OFF'}${proxy ? `, in proxy mode (${proxy.url})` : ''}.`,
        `  Rules: ${rules} enabled · Word lists: ${lists.join(', ') || 'none'}${s.wordlistsInToolOutput ? '' : ' (prompts only)'}`,
        `  Memory: ${plural((stored.memory || []).length, 'term')} · Allowlist: ${plural((stored.allowlist || []).length, 'value')}`,
        `  Prompts: ${s.prompt} · Tool results: ${s.toolOutput ? 'obfuscated' : 'not obfuscated'} · Outbound tools: ${s.outbound} · Network commands: ${s.networkCommands}`,
        proxy
          ? `  Placeholders (proxy, every session): ${new Vault.Vault(S.readJson(ProxyState.vaultFile(), null)).size}`
          : `  Placeholders in this project: ${Vault.read(projectDir).size}`,
        `  Settings: ${S.settingsPath()}`
      ].join('\n');
    }
    case 'help':
    default:
      return HELP;
  }
}

// Settings exported by the browser extension (JSON), or a memory list: "Category<TAB>term[<TAB>partial]" per line
// (the extension's "Export memory") or plain terms, which go to "Other".
function importFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return `Trellis: cannot read ${file} (${e.code || e.message}).`;
  }
  const stored = S.loadStored();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    // not JSON: a memory list
  }
  const parts = [];
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    // A settings file is untrusted input: known keys only, rules reduced to their known fields.
    if (Array.isArray(data.rules)) {
      const rules = data.rules.map(S.sanitizeRule).filter(Boolean);
      stored.rules = rules;
      parts.push(plural(rules.length, 'rule'));
    }
    if (Array.isArray(data.allowlist)) {
      stored.allowlist = data.allowlist.filter((t) => typeof t === 'string').map((t) => t.slice(0, 500));
      parts.push(`${stored.allowlist.length} allowlisted`);
    }
    if (typeof data.exceptionsExtra === 'string') stored.exceptionsExtra = data.exceptionsExtra.slice(0, 100000);
    if (Array.isArray(data.wordlists)) {
      stored.wordlists = data.wordlists.filter((l) => l && typeof l.id === 'string').map((l) => ({ id: l.id, enabled: l.enabled !== false }));
    }
    if (typeof data.enabled === 'boolean') stored.enabled = data.enabled;
    let n = 0;
    for (const m of Array.isArray(data.memory) ? data.memory : []) {
      if (m && typeof m.term === 'string') n += S.addToMemory(stored, [m.term], typeof m.category === 'string' ? m.category : 'Other', { partial: !!m.partial });
    }
    parts.push(plural(n, 'memory term'));
  } else {
    let n = 0;
    for (const line of S.parseWordlist(text)) {
      if (line.includes('\t')) {
        const [category, term, match] = line.split('\t').map((x) => x.trim());
        if (term) n += S.addToMemory(stored, [term], category || 'Other', { partial: match === 'partial' });
      } else {
        n += S.addToMemory(stored, line.split(/[,;]/), 'Other');
      }
    }
    parts.push(plural(n, 'memory term'));
  }
  S.saveStored(stored);
  return `Trellis: imported ${parts.join(', ')}. Review them in ${S.settingsPath()}`;
}

module.exports = { parse, parseTerms, run, NAMES, HELP };
