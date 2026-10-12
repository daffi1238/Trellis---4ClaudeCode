// The Trellis proxy as a systemd user service (Linux).
//
// The plugin's directory changes with every update, so the service runs a copy of the proxy kept in the data
// directory (runtime/). SessionStart refreshes that copy, and restarts the service, when the plugin version changes.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const S = require('./settings.js');
const ProxyState = require('./proxy-state.js');

const NAME = process.env.TRELLIS_SERVICE_NAME || 'trellis-proxy';
// What the proxy needs to run on its own: the scripts, the engine and the word lists.
const RUNTIME_PARTS = ['lib', 'scripts', 'wordlists', '.claude-plugin/plugin.json'];

const unitDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
const unitPath = () => path.join(unitDir(), `${NAME}.service`);
const runtimeDir = () => path.join(S.dataDir(), 'runtime');

function pluginVersion(root) {
  return S.readJson(path.join(root, '.claude-plugin', 'plugin.json'), {}).version || '0';
}

function systemctl(...args) {
  const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 15000 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), missing: r.error?.code === 'ENOENT' };
}

function supported() {
  if (process.platform !== 'linux') return 'the service needs Linux with systemd (on macOS, start the proxy by hand or with launchd)';
  const r = systemctl('--version');
  if (r.missing) return 'systemctl was not found';
  return null;
}

function copyRuntime() {
  const dest = runtimeDir();
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const part of RUNTIME_PARTS) {
    fs.cpSync(path.join(S.ROOT, part), path.join(tmp, part), { recursive: true });
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
}

const quoteArg = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${String(s).replace(/(["\\$])/g, '\\$1')}"`);

function unitText({ port, upstream }) {
  const exec = [process.execPath, path.join(runtimeDir(), 'scripts', 'proxy.js'), '--port', String(port), '--upstream', upstream];
  return [
    '# Created by Trellis for Claude Code (/trellis:proxy install). Remove with /trellis:proxy uninstall.',
    '[Unit]',
    'Description=Trellis proxy for Claude Code (keeps sensitive data out)',
    '',
    '[Service]',
    'Type=simple',
    `Environment=${quoteArg(`TRELLIS_HOME=${S.dataDir()}`)}`,
    `ExecStart=${exec.map(quoteArg).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=2',
    'UMask=0077',
    'NoNewPrivileges=yes',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
}

// Installed for this data directory (a unit created for another one, e.g. by tests, is not this service).
function installed() {
  try {
    return fs.readFileSync(unitPath(), 'utf8').includes(quoteArg(`TRELLIS_HOME=${S.dataDir()}`));
  } catch (e) {
    return false;
  }
}

// Waits until the service's own process (not a proxy started by hand) has published its state.
function waitForProxy(ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const pid = Number(systemctl('show', '-p', 'MainPID', '--value', NAME).out);
    const st = S.readJson(ProxyState.statePath(), null);
    if (pid > 0 && st && st.pid === pid) return st;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }
  return null;
}

function install({ port = 8788, upstream = 'https://api.anthropic.com' } = {}) {
  const why = supported();
  if (why) return { ok: false, message: `Trellis: cannot install the service: ${why}.` };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, message: 'Trellis: --port must be a number from 1 to 65535.' };
  try {
    const u = new URL(upstream);
    if (!/^https?:$/.test(u.protocol)) throw new Error();
  } catch (e) {
    return { ok: false, message: 'Trellis: --upstream must be an http(s) URL.' };
  }
  copyRuntime();
  fs.mkdirSync(unitDir(), { recursive: true });
  fs.writeFileSync(unitPath(), unitText({ port, upstream }));
  systemctl('daemon-reload');
  const enable = systemctl('enable', NAME);
  const restart = systemctl('restart', NAME);
  if (!enable.ok || !restart.ok) return { ok: false, message: `Trellis: systemctl failed: ${(restart.out || enable.out).slice(0, 300)}` };
  const st = waitForProxy();
  if (!st) {
    return { ok: false, message: `Trellis: the service was installed but the proxy did not start (port ${port} in use?). See: journalctl --user -u ${NAME}` };
  }
  return { ok: true, url: st.url, message: `Trellis: proxy service "${NAME}" installed and running at ${st.url} (-> ${upstream}). It starts with your session.` };
}

function uninstall() {
  if (!installed()) return 'Trellis: the proxy service is not installed.';
  systemctl('disable', '--now', NAME);
  fs.rmSync(unitPath(), { force: true });
  systemctl('daemon-reload');
  fs.rmSync(runtimeDir(), { recursive: true, force: true });
  return `Trellis: proxy service "${NAME}" stopped and removed.`;
}

function status() {
  if (!installed()) return null;
  return {
    active: systemctl('is-active', NAME).out || 'unknown',
    enabled: systemctl('is-enabled', NAME).out || 'unknown',
    version: pluginVersion(runtimeDir())
  };
}

// SessionStart: after a plugin update, refresh the service's copy and restart it. Returns a message or null.
function refresh() {
  if (!installed() || supported()) return null;
  const current = pluginVersion(S.ROOT);
  if (pluginVersion(runtimeDir()) === current) return null;
  copyRuntime();
  systemctl('try-restart', NAME);
  return `Trellis: proxy service updated to ${current} and restarted.`;
}

module.exports = { NAME, install, uninstall, status, refresh, unitText, unitPath, runtimeDir, installed };
