// Traffic audit: a real Claude Code with Trellis, against a recording stand-in for the API (fake-api.js). Every
// request Claude Code sends is checked for the original values, and the commands Claude "runs" are checked to have
// used the real ones. No account, cost or network: run with `npm run test:audit` (needs `claude`, or CLAUDE_BIN).
// Fictional data only.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { start } = require('./fake-api.js');

const PLUGIN = path.join(__dirname, '..', '..');
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const available = spawnSync(CLAUDE, ['--version'], { encoding: 'utf8' }).status === 0;

// Values that must never reach the API, in any request.
const ORIGINALS = [
  'laura.martinez@example.com', 'sarah.johnson@example.com', 'diana.prince@example.com', 'ops.lead@example.com',
  'Martínez', 'Sarah Johnson', '10.20.30.40', 'hunter2-Northwind', 'Globex'
];

function project({ claudeMd = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-audit-proj-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'team.yml'), [
    'database:',
    '  host: 10.20.30.40',
    '  owner: Laura Martínez <laura.martinez@example.com>',
    '  password: hunter2-Northwind',
    'billing:',
    '  owner: Sarah Johnson <sarah.johnson@example.com>',
    ''
  ].join('\n'));
  if (claudeMd) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Deploy approvals go to ops.lead@example.com (Globex on-call).\n');
  return dir;
}

function dirs() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-audit-home-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ memory: [{ term: 'Globex', category: 'Company' }] }));
  return { home, config: fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-audit-cc-')) };
}

// The first placeholder of a label in the tool results the model was sent ("[EMAIL_2]").
function placeholderIn(body, label) {
  const results = JSON.stringify((body.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'tool_result'));
  return (results.match(new RegExp(`\\[${label}_\\d+\\]`)) || [null])[0];
}

function runClaude({ cwd, baseUrl, home, config, prompt, args = [] }) {
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: 'sk-ant-audit-not-a-real-key',
    CLAUDE_CONFIG_DIR: config,
    TRELLIS_HOME: home,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
  };
  delete env.ANTHROPIC_AUTH_TOKEN;
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, ['-p', '--plugin-dir', PLUGIN, '--output-format', 'stream-json', '--verbose', ...args, prompt], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const events = out.trim().split('\n').flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch (e) {
          return [];
        }
      });
      resolve({ code, err, events, result: events.find((e) => e.type === 'result') });
    });
  });
}

function assertNoOriginals(requests) {
  assert.ok(requests.some((r) => r.method === 'POST'), 'Claude Code reached the API');
  for (const r of requests) {
    for (const v of ORIGINALS) assert.ok(!r.body.includes(v), `${r.method} ${r.url} sent "${v}"`);
  }
}

const skip = available ? false : `${CLAUDE} not found`;

test('prompt and @ attachment: sent with placeholders', { skip, timeout: 180000 }, async () => {
  const cwd = project();
  const { home, config } = dirs();
  const api = await start(() => [{ type: 'text', text: 'Noted.' }]);
  try {
    const run = await runClaude({ cwd, baseUrl: api.url, home, config, prompt: 'Summarize @team.yml and mail it to diana.prince@example.com' });
    assert.equal(run.code, 0, run.err);
    assertNoOriginals(api.requests);
    const main = api.requests.find((r) => r.body.includes('Summarize @team.yml'));
    assert.match(main.body, /mail it to \[EMAIL_\d+\]/, 'the prompt was rewritten');
    assert.match(main.body, /owner: \[NAME_\d+\] \[SURNAME_\d+\] <\[EMAIL_\d+\]>/, 'the attachment was obfuscated');
  } finally {
    await api.close();
  }
});

test('tool results are obfuscated, and local commands run with the real values', { skip, timeout: 180000 }, async () => {
  const cwd = project();
  const { home, config } = dirs();
  const api = await start((step, body) => {
    if (step === 0) return [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(cwd, 'team.yml') } }];
    if (step === 1) return [{ type: 'tool_use', name: 'Bash', input: { command: `printf '%s' "${placeholderIn(body, 'EMAIL')}" > out.txt`, description: 'Save the owner' } }];
    return [{ type: 'text', text: 'Saved.' }];
  });
  try {
    const run = await runClaude({ cwd, baseUrl: api.url, home, config, prompt: 'Save the database owner email to out.txt', args: ['--permission-mode', 'default', '--allowedTools=Read,Bash'] });
    assert.equal(run.code, 0, run.err);
    assertNoOriginals(api.requests);
    assert.equal(fs.readFileSync(path.join(cwd, 'out.txt'), 'utf8'), 'laura.martinez@example.com');
  } finally {
    await api.close();
  }
});

test('auto mode: no request holds an original value, the classifier\'s included', { skip, timeout: 180000 }, async () => {
  const cwd = project();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-audit-outside-'));
  const { home, config } = dirs();
  const api = await start((step, body) => {
    if (step === 0) return [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(cwd, 'team.yml') } }];
    if (step === 1) {
      return [{ type: 'tool_use', name: 'Bash', input: { command: `git config --file ${path.join(outside, 'gitconfig')} user.email "${placeholderIn(body, 'EMAIL')}"` } }];
    }
    return [{ type: 'text', text: 'Done.' }];
  });
  try {
    const run = await runClaude({ cwd, baseUrl: api.url, home, config, prompt: 'Set that email in the gitconfig', args: ['--permission-mode', 'auto'] });
    assert.equal(run.code, 0, run.err);
    assertNoOriginals(api.requests);
    assert.ok(api.requests.some((r) => r.body.includes('security monitor')), 'the auto-mode classifier was consulted');
    // The command ran (wrapped by Trellis) with the real value.
    const set = spawnSync('git', ['config', '--file', path.join(outside, 'gitconfig'), 'user.email'], { encoding: 'utf8' });
    assert.equal(set.stdout.trim(), 'laura.martinez@example.com');
  } finally {
    await api.close();
  }
});

test('proxy mode: CLAUDE.md included, nothing original reaches the API', { skip, timeout: 180000 }, async () => {
  const cwd = project({ claudeMd: true });
  const { home, config } = dirs();
  const api = await start((step, body) => {
    if (step === 0) return [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(cwd, 'team.yml') } }];
    if (step === 1) return [{ type: 'tool_use', name: 'Bash', input: { command: `printf '%s' "${placeholderIn(body, 'EMAIL')}" > out.txt` } }];
    return [{ type: 'text', text: 'Saved.' }];
  });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proxy = spawn(process.execPath, [path.join(PLUGIN, 'scripts', 'proxy.js'), '--port', String(port), '--upstream', api.url], {
    env: { ...process.env, TRELLIS_HOME: home },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  try {
    await new Promise((resolve, reject) => {
      proxy.stderr.on('data', (d) => /listening/.test(d) && resolve());
      proxy.on('exit', () => reject(new Error('the proxy did not start')));
    });
    const run = await runClaude({ cwd, baseUrl: `http://127.0.0.1:${port}`, home, config, prompt: 'Save the database owner email to out.txt; who is on call?', args: ['--permission-mode', 'default', '--allowedTools=Read,Bash'] });
    assert.equal(run.code, 0, run.err);
    assertNoOriginals(api.requests);
    assert.ok(api.requests.some((r) => r.body.includes('Deploy approvals go to [EMAIL_')), 'CLAUDE.md went through, obfuscated');
    assert.equal(fs.readFileSync(path.join(cwd, 'out.txt'), 'utf8'), 'laura.martinez@example.com');
  } finally {
    proxy.kill('SIGTERM');
    await api.close();
  }
});
