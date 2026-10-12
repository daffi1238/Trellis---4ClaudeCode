// Vault encryption and where its key is kept. Fictional data only.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'scripts', 'hook.js');
const REAL = 'sarah.johnson@example.com';

function sandbox(envPatch = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-proj-'));
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-config-'));
  const env = { ...process.env, TRELLIS_HOME: home, CLAUDE_PROJECT_DIR: project, XDG_CONFIG_HOME: config, ...envPatch };
  for (const [k, v] of Object.entries(envPatch)) if (v === undefined) delete env[k];
  delete env.CLAUDE_PLUGIN_DATA;
  const run = (input, extraEnv = {}) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: project, ...input }), env: { ...env, ...extraEnv }, encoding: 'utf8' });
    return { out: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
  };
  const post = (stdout, extraEnv) => run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout } }, extraEnv);
  const pre = (command, extraEnv) => run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, extraEnv);
  const vaultFiles = () => fs.readdirSync(path.join(home, 'vault')).filter((f) => f.endsWith('.json'));
  const vaultFile = () => path.join(home, 'vault', vaultFiles()[0]);
  return { home, project, config, env, run, post, pre, vaultFiles, vaultFile };
}

test('the vault on disk is encrypted, and placeholders still restore', () => {
  const sb = sandbox();
  assert.equal(sb.post(REAL).out.hookSpecificOutput.updatedToolOutput.stdout, '[EMAIL_1]');
  const raw = fs.readFileSync(sb.vaultFile(), 'utf8');
  assert.doesNotMatch(raw, /sarah|EMAIL/);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['alg', 'data', 'iv', 'tag', 'v']);
  assert.equal(sb.pre('echo [EMAIL_1]').out.hookSpecificOutput.updatedInput.command, `echo ${REAL}`);
});

test('a plain vault from an earlier version is read, then encrypted at session start', () => {
  const sb = sandbox();
  sb.post('nothing'); // creates the vault directory layout
  const file = path.join(sb.home, 'vault', crypto.createHash('sha256').update(path.resolve(sb.project)).digest('hex').slice(0, 24) + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, tokens: { '[EMAIL_1]': { label: 'EMAIL', value: REAL } }, counters: { EMAIL: 1 } }));
  assert.equal(sb.pre('echo [EMAIL_1]').out.hookSpecificOutput.updatedInput.command, `echo ${REAL}`, 'still readable');
  sb.run({ hook_event_name: 'SessionStart', source: 'startup' });
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /sarah/);
  assert.equal(sb.pre('echo [EMAIL_1]').out.hookSpecificOutput.updatedInput.command, `echo ${REAL}`, 'readable after encryption');
});

test('a vault the key cannot open is moved aside, and Trellis keeps working', () => {
  const sb = sandbox();
  sb.post(REAL);
  const other = crypto.randomBytes(32).toString('base64');
  const r = sb.post('ops@example.com', { TRELLIS_VAULT_KEY: other });
  assert.equal(r.out.hookSpecificOutput.updatedToolOutput.stdout, '[EMAIL_1]');
  assert.match(r.stderr, /could not be opened with the current key; moved to/);
  assert.equal(fs.readdirSync(path.join(sb.home, 'vault')).filter((f) => f.includes('.unreadable-')).length, 1);
});

test('without a keyring, the key goes to a 0600 file outside the data directory, reused by every process', () => {
  const sb = sandbox({ TRELLIS_VAULT_KEY: undefined, TRELLIS_KEY_STORE: 'file' });
  sb.post(REAL);
  const record = path.join(sb.config, 'trellis', 'vault-key.json');
  assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).store, 'file');
  assert.equal(fs.statSync(record).mode & 0o777, 0o600);
  assert.ok(!record.startsWith(sb.home));
  assert.equal(sb.pre('echo [EMAIL_1]').out.hookSpecificOutput.updatedInput.command, `echo ${REAL}`);
  assert.match(sb.run({ hook_event_name: 'UserPromptSubmit', prompt: '/trellis:status' }).out.reason, /Vault: encrypted \(AES-256-GCM\), key in file .*vault-key\.json/);
});

test('with secret-tool, the key goes to the keyring; a locked keyring fails closed', { skip: process.platform !== 'linux' }, () => {
  // A stand-in secret-tool that keeps the secret in a file, and can play a locked keyring.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-bin-'));
  const store = path.join(bin, 'secret');
  fs.writeFileSync(path.join(bin, 'secret-tool'), `#!/bin/sh
[ -n "$FAKE_LOCKED" ] && exit 1
case "$1" in
  --version) echo fake ;;
  store) cat > "${store}" ;;
  lookup) [ -f "${store}" ] && cat "${store}" || exit 1 ;;
esac
`, { mode: 0o755 });
  const sb = sandbox({ TRELLIS_VAULT_KEY: undefined, PATH: `${bin}:${process.env.PATH}` });
  sb.post(REAL);
  const record = JSON.parse(fs.readFileSync(path.join(sb.config, 'trellis', 'vault-key.json'), 'utf8'));
  assert.deepEqual(record, { store: 'keyring', service: 'trellis-vault', account: 'default' }, 'no key in the record');
  assert.equal(Buffer.from(fs.readFileSync(store, 'utf8'), 'base64').length, 32);
  assert.equal(sb.pre('echo [EMAIL_1]').out.hookSpecificOutput.updatedInput.command, `echo ${REAL}`);
  // Locked: never a new key, never a fresh vault; tool output is withheld instead of sent unobfuscated.
  const locked = sb.post('ops@example.com', { FAKE_LOCKED: '1' });
  assert.match(locked.out.hookSpecificOutput.updatedToolOutput.stdout, /withheld/);
  assert.equal(fs.readdirSync(path.join(sb.home, 'vault')).filter((f) => f.includes('.unreadable-')).length, 0);
  assert.equal(sb.pre('echo [EMAIL_1]').out.hookSpecificOutput.updatedInput.command, `echo ${REAL}`, 'unlocked again: same vault');
});
