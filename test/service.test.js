// The systemd unit and the checks around it, without touching systemd (it is exercised by hand, see README).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRELLIS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis home-'));
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-xdg-'));
process.env.TRELLIS_SERVICE_NAME = 'trellis-proxy-unit-test';
const Service = require('../lib/service.js');

test('the unit runs the copy in the data directory with this node, quoting paths with spaces', () => {
  const unit = Service.unitText({ port: 8790, upstream: 'https://api.example.com' });
  assert.match(unit, new RegExp(`^Environment="TRELLIS_HOME=${process.env.TRELLIS_HOME}"$`, 'm'));
  assert.ok(unit.includes(`ExecStart=${process.execPath} "${path.join(process.env.TRELLIS_HOME, 'runtime', 'scripts', 'proxy.js')}" --port 8790 --upstream https://api.example.com`));
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.match(unit, /^Restart=on-failure$/m);
});

test('a unit for another data directory is not this service', () => {
  fs.mkdirSync(path.dirname(Service.unitPath()), { recursive: true });
  fs.writeFileSync(Service.unitPath(), '[Service]\nEnvironment=TRELLIS_HOME=/somewhere/else\n');
  assert.equal(Service.installed(), false);
  assert.equal(Service.refresh(), null, 'never restarts a service it does not own');
  fs.writeFileSync(Service.unitPath(), Service.unitText({ port: 8790, upstream: 'https://api.example.com' }));
  assert.equal(Service.installed(), true);
});

test('install validates its options before touching anything', { skip: process.platform !== 'linux' }, () => {
  assert.match(Service.install({ port: 0 }).message, /--port must be/);
  assert.match(Service.install({ port: 8790, upstream: 'file:///etc/passwd' }).message, /--upstream must be/);
  assert.equal(fs.existsSync(Service.runtimeDir()), false);
});
