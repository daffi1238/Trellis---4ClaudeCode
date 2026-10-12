// Whether this Claude Code session runs behind the Trellis proxy.
//
// The proxy writes proxy-state.json (its URL and pid) in the data directory while it runs. A session uses it when
// ANTHROPIC_BASE_URL points to that URL and the process is alive. Then the proxy does all obfuscation and
// restoration, with its own vault, and the hooks must not: two vaults would number placeholders differently.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { dataDir, readJson, writePrivate } = require('./settings.js');

const statePath = () => path.join(dataDir(), 'proxy-state.json');
const vaultFile = () => path.join(dataDir(), 'vault', 'proxy.json');

function hostOf(url) {
  try {
    const u = new URL(url);
    const host = u.hostname === 'localhost' || u.hostname === '[::1]' ? '127.0.0.1' : u.hostname;
    return `${host}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`;
  } catch (e) {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function write(state) {
  writePrivate(statePath(), JSON.stringify({ ...state, pid: process.pid }) + '\n');
}

function clear() {
  const st = readJson(statePath(), null);
  if (st && st.pid === process.pid) fs.rmSync(statePath(), { force: true });
}

// The running proxy's state when this process's ANTHROPIC_BASE_URL points to it, else null.
function active(env = process.env) {
  const base = env.ANTHROPIC_BASE_URL;
  if (!base) return null;
  const st = readJson(statePath(), null);
  if (!st || typeof st.url !== 'string' || !Number.isInteger(st.pid)) return null;
  if (hostOf(base) !== hostOf(st.url) || !alive(st.pid)) return null;
  return st;
}

module.exports = { statePath, vaultFile, write, clear, active, hostOf };
