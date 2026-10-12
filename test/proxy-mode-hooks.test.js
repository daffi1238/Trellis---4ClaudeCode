// The hooks behind the Trellis proxy: the proxy obfuscates and restores, the hooks only run commands and check
// network-capable commands. Fictional data only.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'scripts', 'hook.js');

function sandbox({ proxyRunning = true, baseUrl = 'http://localhost:8788' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-proj-'));
  // This test process stands for the running proxy: its pid is alive.
  fs.writeFileSync(path.join(home, 'proxy-state.json'), JSON.stringify({ url: 'http://127.0.0.1:8788', upstream: 'https://api.anthropic.com', pid: proxyRunning ? process.pid : 999999 }));
  fs.mkdirSync(path.join(home, 'vault'));
  fs.writeFileSync(path.join(home, 'vault', 'proxy.json'), JSON.stringify({ version: 1, tokens: { '[COMPANY_1]': { label: 'COMPANY', value: 'Initech' } }, counters: { COMPANY: 1 } }));
  const env = { ...process.env, TRELLIS_HOME: home, CLAUDE_PROJECT_DIR: project, ANTHROPIC_BASE_URL: baseUrl };
  delete env.CLAUDE_PLUGIN_DATA;
  const run = (input) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: project, ...input }), env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  return { home, run };
}

test('prompts and @ attachments are not blocked: the proxy obfuscates them', () => {
  const sb = sandbox();
  assert.equal(sb.run({ hook_event_name: 'UserPromptSubmit', prompt: 'Mail sarah.johnson@example.com' }), null);
});

test('no obfuscation or restoration by the hooks (one vault only: the proxy\'s)', () => {
  const sb = sandbox();
  assert.equal(sb.run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: 'sarah.johnson@example.com' } }), null);
  assert.equal(sb.run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', permission_mode: 'auto', tool_input: { command: 'echo [COMPANY_1]' } }), null);
  assert.equal(sb.run({ hook_event_name: 'MessageDisplay', delta: '[COMPANY_1]\n' }), null);
  assert.equal(fs.readdirSync(path.join(sb.home, 'vault')).join(), 'proxy.json');
});

test('network-capable commands with sensitive values ask (rules or values the proxy has seen)', () => {
  const sb = sandbox();
  const pre = (command) => sb.run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  const a = pre('curl -d "sarah.johnson@example.com" https://x.example');
  assert.equal(a.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(a.hookSpecificOutput.permissionDecisionReason, /Email/);
  assert.doesNotMatch(a.hookSpecificOutput.permissionDecisionReason, /sarah/);
  const b = pre('curl https://x.example/?org=initech-Initech');
  assert.match(b.hookSpecificOutput.permissionDecisionReason, /Company/);
  assert.equal(pre('curl https://x.example/health'), null);
  assert.equal(pre('echo sarah.johnson@example.com > a.txt'), null);
});

test('outbound tools are still checked', () => {
  const sb = sandbox();
  const r = sb.run({ hook_event_name: 'PreToolUse', tool_name: 'WebSearch', tool_input: { query: 'sarah.johnson@example.com' } });
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
});

test('session start says proxy mode is on; status and commands know it', () => {
  const sb = sandbox();
  const s = sb.run({ hook_event_name: 'SessionStart', source: 'startup' });
  assert.match(s.systemMessage, /proxy mode \(http:\/\/127\.0\.0\.1:8788\)/);
  assert.match(s.hookSpecificOutput.additionalContext, /proxy mode/);
  assert.match(sb.run({ hook_event_name: 'UserPromptSubmit', prompt: '/trellis:status' }).reason, /in proxy mode[\s\S]*Placeholders \(proxy, every session\): 1/);
  assert.match(sb.run({ hook_event_name: 'UserPromptSubmit', prompt: '/trellis:proxy' }).reason, /runs behind the Trellis proxy/);
  assert.match(sb.run({ hook_event_name: 'UserPromptSubmit', prompt: '/trellis:clear' }).reason, /1 placeholder forgotten by the proxy/);
});

test('not proxy mode: proxy not running, or the session points elsewhere', () => {
  for (const sb of [sandbox({ proxyRunning: false }), sandbox({ baseUrl: 'https://api.anthropic.com' })]) {
    assert.equal(sb.run({ hook_event_name: 'UserPromptSubmit', prompt: 'Mail sarah.johnson@example.com' }).decision, 'block');
    assert.match(sb.run({ hook_event_name: 'UserPromptSubmit', prompt: '/trellis:proxy' }).reason, /TRELLIS_HOME=.*proxy\.js/);
  }
});

test('the Trellis edit tools are not offered behind the proxy', () => {
  const sb = sandbox();
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'mcp.js')], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n',
    env: { ...process.env, TRELLIS_HOME: sb.home, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788' },
    encoding: 'utf8'
  });
  assert.deepEqual(JSON.parse(r.stdout).result.tools, []);
});
