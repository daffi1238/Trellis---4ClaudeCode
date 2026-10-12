// Vault: placeholder -> original value, per project, in a file only the user can read.
//
// Unlike the browser extension, a placeholder stands for one exact value ("Laura" and "LAURA" get different
// placeholders): placeholders are written back into real files, so they must restore byte for byte.
//
// Hooks run in parallel (several tool calls at once), so every read-modify-write holds a lock.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { dataDir, readJson, writePrivate } = require('./settings.js');

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
  return new Vault(readJson(vaultPath(projectDir), null));
}

// Runs fn(vault) under the lock and saves the vault if fn added placeholders.
function update(projectDir, fn) {
  return updateFile(vaultPath(projectDir), fn);
}

// Same, for a vault file given by path (the proxy keeps one vault for every session).
function updateFile(file, fn) {
  return withLock(file, () => {
    const vault = new Vault(readJson(file, null));
    const result = fn(vault);
    if (vault.dirty) writePrivate(file, JSON.stringify(vault.data));
    return result;
  });
}

function clear(projectDir) {
  const file = vaultPath(projectDir);
  return withLock(file, () => {
    const n = new Vault(readJson(file, null)).size;
    fs.rmSync(file, { force: true });
    return n;
  });
}

module.exports = { Vault, read, update, updateFile, clear, vaultPath, projectKey };
