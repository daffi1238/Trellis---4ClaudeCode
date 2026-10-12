// The key that encrypts the vaults (AES-256-GCM), kept apart from them.
//
// Where it lives, in order:
//   1. $TRELLIS_VAULT_KEY (base64, 32 bytes): tests and automation
//   2. the system keyring: macOS Keychain (`security`) or the Linux Secret Service (`secret-tool`, from
//      libsecret-tools)
//   3. a key file in ~/.config/trellis/ (0600), outside the data directory, so a backup or sync of ~/.claude does
//      not carry the vaults and their key together
//
// ~/.config/trellis/vault-key.json records which one holds the key (and the key itself for the file store), so a
// locked keyring never leads to a new key that could not read the existing vaults.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SERVICE = 'trellis-vault';
const ACCOUNT = 'default';

class KeyUnavailableError extends Error {}

const configDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'trellis');
const recordPath = () => path.join(configDir(), 'vault-key.json');

function run(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 5000 });
  return { ok: !r.error && r.status === 0, out: (r.stdout || '').trim(), missing: r.error?.code === 'ENOENT' };
}

// The system keyring for this platform, or null when there is none to use.
function keyring() {
  const forced = process.env.TRELLIS_KEY_STORE;
  if (forced === 'file') return null;
  if (process.platform === 'darwin') {
    return {
      name: 'macOS Keychain',
      get: () => run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']),
      set: (b64) => run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-l', 'Trellis vault key', '-w', b64])
    };
  }
  if (process.platform === 'linux') {
    const probe = run('secret-tool', ['--version']);
    if (probe.missing) return null;
    return {
      name: 'Secret Service keyring',
      get: () => run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]),
      // The secret goes through stdin, never the command line.
      set: (b64) => run('secret-tool', ['store', '--label=Trellis vault key', 'service', SERVICE, 'account', ACCOUNT], b64)
    };
  }
  return null;
}

function decode(b64) {
  const key = Buffer.from(String(b64 || '').trim(), 'base64');
  return key.length === 32 ? key : null;
}

function writeRecord(record) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const tmp = `${recordPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, recordPath());
}

let cached = null;

// The vault key; created on first use. Throws KeyUnavailableError when the recorded store cannot give it.
function getKey() {
  if (cached) return cached.key;
  if (process.env.TRELLIS_VAULT_KEY) {
    const key = decode(process.env.TRELLIS_VAULT_KEY);
    if (!key) throw new KeyUnavailableError('TRELLIS_VAULT_KEY must be 32 bytes in base64');
    cached = { key, store: 'environment variable' };
    return key;
  }
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(recordPath(), 'utf8'));
  } catch (e) {
    // no key yet
  }
  if (record?.store === 'file') {
    const key = decode(record.key);
    if (!key) throw new KeyUnavailableError(`the key in ${recordPath()} is damaged`);
    cached = { key, store: `file ${recordPath()}` };
    return key;
  }
  if (record?.store === 'keyring') {
    const ring = keyring();
    const got = ring?.get();
    const key = got?.ok ? decode(got.out) : null;
    if (!key) throw new KeyUnavailableError('the vault key is in the system keyring, which could not be read (is it locked, or is secret-tool missing?)');
    cached = { key, store: ring.name };
    return key;
  }
  // First use: a new key, in the keyring when there is one.
  const key = crypto.randomBytes(32);
  const ring = keyring();
  if (ring && ring.set(key.toString('base64')).ok && decode(ring.get().out)?.equals(key)) {
    writeRecord({ store: 'keyring', service: SERVICE, account: ACCOUNT });
    cached = { key, store: ring.name };
  } else {
    writeRecord({ store: 'file', key: key.toString('base64') });
    cached = { key, store: `file ${recordPath()}` };
  }
  return key;
}

// Where the key is, for /trellis:status ("macOS Keychain", "file ~/.config/trellis/vault-key.json"...).
function describe() {
  try {
    getKey();
    return cached.store.replace(os.homedir(), '~');
  } catch (e) {
    return `unavailable (${e.message})`;
  }
}

function resetCache() {
  cached = null;
}

module.exports = { getKey, describe, resetCache, recordPath, KeyUnavailableError };
