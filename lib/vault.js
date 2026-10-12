// Vault: placeholder -> original value, per project, in a file only the user can read.
//
// Unlike the browser extension, a placeholder stands for one exact value ("Laura" and "LAURA" get different
// placeholders): placeholders are written back into real files, so they must restore byte for byte.
//
// Hooks run in parallel (several tool calls at once), so every read-modify-write holds a lock.
//
// Vault files are encrypted with AES-256-GCM; the key is kept apart (lib/keystore.js). Plain vaults written by
// earlier versions are still read, and are encrypted the next time they are written (or at session start).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { dataDir, writePrivate } = require('./settings.js');
const Keystore = require('./keystore.js');

const AAD = Buffer.from('trellis-vault-v2');

function encrypt(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Keystore.getKey(), iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 2, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: body.toString('base64') });
}

// { data, plain } for a vault file; data null when there is none. A file the key cannot open (another key, or
// damaged) is moved aside so Trellis keeps working: its placeholders can no longer be restored.
function readVaultFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { data: null, plain: false };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    json = null;
  }
  if (json && json.tokens && json.v === undefined) return { data: json, plain: true }; // written before encryption
  if (json && json.v === 2) {
    const key = Keystore.getKey(); // KeyUnavailableError propagates: fail closed, never a fresh vault
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(json.iv, 'base64'));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(json.tag, 'base64'));
      const text = Buffer.concat([decipher.update(Buffer.from(json.data, 'base64')), decipher.final()]).toString('utf8');
      return { data: JSON.parse(text), plain: false };
    } catch (e) {
      // falls through to moving it aside
    }
  }
  const aside = `${file}.unreadable-${Date.now()}`;
  try {
    fs.renameSync(file, aside);
    process.stderr.write(`Trellis: the vault ${file} could not be opened with the current key; moved to ${aside}. Earlier placeholders can no longer be restored.\n`);
  } catch (e) {
    // another process moved it first
  }
  return { data: null, plain: false };
}

const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 5000;

function projectKey(projectDir) {
  return crypto.createHash('sha256').update(path.resolve(projectDir || '.')).digest('hex').slice(0, 24);
}

function vaultPath(projectDir) {
  return path.join(dataDir(), 'vault', projectKey(projectDir) + '.json');
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(file, fn) {
  const lock = file + '.lock';
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch (ignored) {
        // removed by its owner meanwhile
      }
      if (Date.now() > deadline) throw new Error('Trellis vault is locked');
      sleep(15 + Math.random() * 30);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function emptyData() {
  return { version: 1, tokens: {}, counters: {} };
}

class Vault {
  constructor(data) {
    this.data = data && data.tokens ? data : emptyData();
    this.byValue = new Map();
    for (const [token, { label, value }] of Object.entries(this.data.tokens)) this.byValue.set(label + '\u0000' + value, token);
    this.dirty = false;
  }

  get size() {
    return Object.keys(this.data.tokens).length;
  }

  tokenFor(label, value) {
    const key = label + '\u0000' + value;
    let token = this.byValue.get(key);
    if (!token) {
      const n = (this.data.counters[label] || 0) + 1;
      this.data.counters[label] = n;
      token = `[${label}_${n}]`;
      this.data.tokens[token] = { label, value };
      this.byValue.set(key, token);
      this.dirty = true;
    }
    return token;
  }

  valueOf(token) {
    return Object.prototype.hasOwnProperty.call(this.data.tokens, token) ? this.data.tokens[token].value : undefined;
  }
}

// Read-only snapshot (no lock needed: the file is replaced atomically).
function read(projectDir) {
  return readFile(vaultPath(projectDir));
}

// Read-only snapshot of a vault file given by path.
function readFile(file) {
  return new Vault(readVaultFile(file).data);
}

// Runs fn(vault) under the lock and saves the vault if fn added placeholders.
function update(projectDir, fn) {
  return updateFile(vaultPath(projectDir), fn);
}

// Same, for a vault file given by path (the proxy keeps one vault for every session).
function updateFile(file, fn) {
  return withLock(file, () => {
    const { data, plain } = readVaultFile(file);
    const vault = new Vault(data);
    const result = fn(vault);
    if (vault.dirty || plain) writePrivate(file, encrypt(vault.data));
    return result;
  });
}

function clear(projectDir) {
  const file = vaultPath(projectDir);
  return withLock(file, () => {
    const n = new Vault(readVaultFile(file).data).size;
    fs.rmSync(file, { force: true });
    return n;
  });
}

// Encrypts a vault written by an earlier version in place (session start). Returns whether it did.
function encryptInPlace(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!json.tokens || json.v !== undefined) return false;
  } catch (e) {
    return false;
  }
  updateFile(file, () => {}); // a plain vault is always written back encrypted
  return true;
}

module.exports = { Vault, read, readFile, update, updateFile, clear, encryptInPlace, vaultPath, projectKey };
