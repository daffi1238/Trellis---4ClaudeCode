// scripts/sync-engine.js against a fake Trellis checkout, writing to a temporary plugin directory.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SYNC = path.join(__dirname, '..', 'scripts', 'sync-engine.js');
const PLUGIN = path.join(__dirname, '..');

function fakeTrellis() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-src-'));
  fs.mkdirSync(path.join(dir, 'wordlists'));
  fs.writeFileSync(path.join(dir, 'obfuscator.js'), '// engine v1\n');
  fs.writeFileSync(path.join(dir, 'wordlists', 'first-names.txt'), 'Laura\nSarah\n');
  fs.writeFileSync(path.join(dir, 'THIRD_PARTY_NOTICES.md'), '# Third-party notices\n');
  fs.writeFileSync(
    path.join(dir, 'defaults.js'),
    `globalThis.TRELLIS_DEFAULTS = { rules: [
      { id: 'kw-example', name: 'Keywords', type: 'keyword', pattern: 'Acme Corp', enabled: false },
      { id: 'email', name: 'Email', type: 'regex', pattern: '\\\\S+@\\\\S+', flags: 'g', replacement: '', enabled: true }
    ] };
    globalThis.TRELLIS_OUTDATED_PATTERNS = { email: ['old@pattern'] };
    globalThis.trellisGetSettings = async function () { return chrome.storage.local.get(null); };\n`
  );
  return dir;
}

const run = (...args) => spawnSync(process.execPath, [SYNC, ...args], { encoding: 'utf8' });

test('copies the engine, lists and rules; check passes afterwards', () => {
  const src = fakeTrellis();
  const to = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-plugin-'));
  assert.equal(run('--from', src, '--to', to, '--check').status, 1);
  const r = run('--from', src, '--to', to);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(to, 'lib', 'obfuscator.js'), 'utf8'), '// engine v1\n');
  assert.equal(fs.readFileSync(path.join(to, 'wordlists', 'first-names.txt'), 'utf8'), 'Laura\nSarah\n');
  const rules = JSON.parse(fs.readFileSync(path.join(to, 'lib', 'default-rules.json'), 'utf8'));
  assert.deepEqual(rules.map((x) => x.id), ['email'], 'the disabled keyword example is left out');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(to, 'lib', 'outdated-patterns.json'), 'utf8')), { email: ['old@pattern'] });
  assert.equal(fs.readFileSync(path.join(to, 'THIRD_PARTY_NOTICES.md'), 'utf8'), '# Third-party notices\n');
  assert.equal(run('--from', src, '--to', to, '--check').status, 0);
});

test('check reports drift without writing, and sync removes lists gone from Trellis', () => {
  const src = fakeTrellis();
  const to = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-plugin-'));
  run('--from', src, '--to', to);
  fs.writeFileSync(path.join(src, 'obfuscator.js'), '// engine v2\n');
  fs.writeFileSync(path.join(to, 'wordlists', 'old.txt'), 'x\n');
  const c = run('--from', src, '--to', to, '--check');
  assert.equal(c.status, 1);
  assert.match(c.stdout, /differs: lib\/obfuscator\.js/);
  assert.match(c.stdout, /not in Trellis: wordlists\/old\.txt/);
  assert.equal(fs.readFileSync(path.join(to, 'lib', 'obfuscator.js'), 'utf8'), '// engine v1\n', 'check never writes');
  run('--from', src, '--to', to);
  assert.equal(fs.existsSync(path.join(to, 'wordlists', 'old.txt')), false);
  assert.equal(run('--from', src, '--to', to, '--check').status, 0);
});

test('a directory that is not a Trellis checkout is an error', () => {
  const r = run('--from', os.tmpdir(), '--to', fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-plugin-')), '--check');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not look like a Trellis checkout/);
});

test('this plugin is in sync with Trellis (when TRELLIS_SRC points to a checkout)', { skip: !process.env.TRELLIS_SRC }, () => {
  const r = run('--to', PLUGIN, '--check');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
