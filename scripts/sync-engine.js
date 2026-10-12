#!/usr/bin/env node
// Keeps the detection engine in step with the Trellis browser extension (https://github.com/daffi1238/Trellis):
//
//   obfuscator.js             -> lib/obfuscator.js          (verbatim)
//   wordlists/*.txt           -> wordlists/*.txt            (verbatim; files gone from Trellis are removed)
//   defaults.js (rules)       -> lib/default-rules.json     (minus the browser's disabled keyword example)
//
//   node scripts/sync-engine.js --from ../Trellis           copy
//   node scripts/sync-engine.js --from ../Trellis --check   only compare; exit 1 if anything differs (CI)
//
// The source can also be given in $TRELLIS_SRC. --to <dir> writes somewhere else than this plugin (tests).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PLUGIN_ROOT = path.join(__dirname, '..');
// Rules of the extension that make no sense here: the disabled example of a keyword rule.
const SKIP_RULES = new Set(['kw-example']);

function parseArgs(argv) {
  const args = { check: false, from: process.env.TRELLIS_SRC || null, to: PLUGIN_ROOT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--from') args.from = argv[++i];
    else if (argv[i].startsWith('--from=')) args.from = argv[i].slice(7);
    else if (argv[i] === '--to') args.to = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.from) throw new Error('usage: node scripts/sync-engine.js --from <path to a Trellis checkout> [--check]');
  return args;
}

// The default rules, read by running defaults.js in a sandbox (it only assigns to globalThis at load time).
function trellisRules(src) {
  const ctx = {};
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(src, 'defaults.js'), 'utf8'), ctx, { filename: 'defaults.js' });
  const rules = ctx.TRELLIS_DEFAULTS?.rules;
  if (!Array.isArray(rules) || !rules.length) throw new Error('no rules found in defaults.js');
  return JSON.parse(JSON.stringify(rules.filter((r) => !SKIP_RULES.has(r.id))));
}

// What the plugin should contain: { relative path -> content }, plus the files that should not exist.
function expected(src, root) {
  for (const f of ['obfuscator.js', 'defaults.js', 'wordlists']) {
    if (!fs.existsSync(path.join(src, f))) throw new Error(`${src} does not look like a Trellis checkout (missing ${f})`);
  }
  const files = new Map();
  files.set('lib/obfuscator.js', fs.readFileSync(path.join(src, 'obfuscator.js'), 'utf8'));
  const lists = fs.readdirSync(path.join(src, 'wordlists')).filter((f) => f.endsWith('.txt')).sort();
  for (const f of lists) files.set(`wordlists/${f}`, fs.readFileSync(path.join(src, 'wordlists', f), 'utf8'));
  files.set('lib/default-rules.json', JSON.stringify(trellisRules(src), null, 2) + '\n');
  const stale = fs.existsSync(path.join(root, 'wordlists'))
    ? fs.readdirSync(path.join(root, 'wordlists')).filter((f) => f.endsWith('.txt') && !lists.includes(f)).map((f) => `wordlists/${f}`)
    : [];
  return { files, stale };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const src = path.resolve(args.from);
  const root = path.resolve(args.to);
  const { files, stale } = expected(src, root);
  const differ = [];
  for (const [rel, content] of files) {
    const target = path.join(root, rel);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current === content) continue;
    differ.push(`${current === null ? 'missing' : 'differs'}: ${rel}`);
    if (!args.check) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }
  for (const rel of stale) {
    differ.push(`not in Trellis: ${rel}`);
    if (!args.check) fs.rmSync(path.join(root, rel));
  }

  if (!differ.length) {
    console.log(`In sync with ${src} (${files.size} files).`);
    return;
  }
  console.log(differ.join('\n'));
  if (args.check) {
    console.error('\nThe engine is out of sync with Trellis. Run: node scripts/sync-engine.js --from <Trellis checkout>');
    process.exitCode = 1;
  } else {
    console.log(`\nUpdated ${differ.length} file(s). Run npm test and review the diff before committing.`);
  }
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exitCode = 2;
}
