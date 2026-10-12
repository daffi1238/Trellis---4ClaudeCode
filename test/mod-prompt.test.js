// scripts/mod-prompt.js, the helper the Trellis mod runs, and how the UserPromptSubmit hook treats prompts it
// already rewrote. Fictional data only.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HELPER = path.join(__dirname, '..', 'scripts', 'mod-prompt.js');
const HOOK = path.join(__dirname, '..', 'scripts', 'hook.js');

function sandbox(settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-proj-'));
  if (settings) fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
  const env = { ...process.env, TRELLIS_HOME: home, CLAUDE_PROJECT_DIR: project };
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.ANTHROPIC_BASE_URL;
  const helper = (req) => {
    const r = spawnSync(process.execPath, [HELPER], { input: JSON.stringify({ root: project, cwd: project, sessionId: 's1', ...req }), env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const hook = (input) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: project, session_id: 's1', ...input }), env, encoding: 'utf8' });
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  return { home, project, helper, hook };
}

test('submit: the prompt is rewritten with the project vault, and the hook lets exactly that text through', () => {
  const sb = sandbox();
  const out = sb.helper({ mode: 'submit', text: 'Mail laura.martinez@example.com about the API key sk-ant-abcdefghijklmnopqrstuvwxyz' });
  assert.equal(out.text, 'Mail [EMAIL_1] about the API key [API_KEY_1]');
  assert.equal(out.summary, 'Email, Api key');
  assert.equal(sb.hook({ hook_event_name: 'UserPromptSubmit', prompt: out.text }), null);
  // Placeholders restore for local tools, as with the hooks.
  const pre = sb.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo [EMAIL_1]' } });
  assert.equal(pre.hookSpecificOutput.updatedInput.command, 'echo laura.martinez@example.com');
});

test('the hook still blocks a prompt the mod did not produce (another session, or the mod failed)', () => {
  const sb = sandbox();
  sb.helper({ mode: 'submit', text: 'Mail laura.martinez@example.com' });
  const other = sb.hook({ hook_event_name: 'UserPromptSubmit', session_id: 's2', prompt: 'Mail sarah.johnson@example.com' });
  assert.equal(other.decision, 'block');
  assert.match(other.reason, /2\.1\.287/);
  const changed = sb.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Mail sarah.johnson@example.com' });
  assert.equal(changed.decision, 'block', 'a mark only covers the exact text it was made for');
});

test('submit: @mentions of files are kept so they still resolve; other @words are obfuscated as text', () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.project, 'clients'));
  fs.writeFileSync(path.join(sb.project, 'clients', 'Laura.txt'), 'notes\n');
  const out = sb.helper({ mode: 'submit', text: 'Summarize @clients/Laura.txt for Laura (@Laura on chat)' });
  assert.equal(out.text, 'Summarize @clients/Laura.txt for [NAME_1] (@[NAME_1] on chat)');
});

test('submit: commands, block mode, proxy mode and disabled are left to the hooks', () => {
  assert.match(sandbox().helper({ mode: 'submit', text: '/trellis:add laura.martinez@example.com' }).skip, /command/);
  assert.match(sandbox({ prompt: 'block' }).helper({ mode: 'submit', text: 'a@example.com' }).skip, /block/);
  assert.match(sandbox({ enabled: false }).helper({ mode: 'submit', text: 'a@example.com' }).skip, /disabled/);
});

test('mention: files with sensitive data are read from an obfuscated copy; others are kept', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.project, 'team.yml'), 'owner: sarah.johnson@example.com\n');
  fs.writeFileSync(path.join(sb.project, 'clean.txt'), 'nothing here\n');
  fs.writeFileSync(path.join(sb.project, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const out = sb.helper({ mode: 'mention', path: 'team.yml' });
  assert.equal(path.basename(out.path), 'team.yml');
  assert.ok(out.path.startsWith(path.join(sb.home, 'mentions')));
  assert.equal(fs.readFileSync(out.path, 'utf8'), 'owner: [EMAIL_1]\n');
  assert.equal(fs.statSync(out.path).mode & 0o777, 0o600);
  assert.deepEqual(sb.helper({ mode: 'mention', path: 'clean.txt' }), { keep: true });
  assert.deepEqual(sb.helper({ mode: 'mention', path: 'logo.png' }), { keep: true });
  assert.deepEqual(sb.helper({ mode: 'mention', path: 'missing.txt' }), { keep: true });
  // The hook does not block a prompt whose @ attachment the mod handles.
  const prompt = sb.helper({ mode: 'submit', text: 'Summarize @team.yml' }).text;
  assert.equal(sb.hook({ hook_event_name: 'UserPromptSubmit', prompt }), null);
});

test('the data directory pointer: the helper finds the plugin data the hooks were given', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-data-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-userhome-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ memory: [{ term: 'Initech', category: 'Client' }] }));
  const base = { ...process.env, HOME: fakeHome };
  delete base.TRELLIS_HOME;
  delete base.ANTHROPIC_BASE_URL;
  // A hook run (with CLAUDE_PLUGIN_DATA) leaves the pointer...
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: fakeHome }), env: { ...base, CLAUDE_PLUGIN_DATA: data }, encoding: 'utf8' });
  // ...and the helper, started without it, uses the same memory.
  const env = { ...base };
  delete env.CLAUDE_PLUGIN_DATA;
  const r = spawnSync(process.execPath, [HELPER], { input: JSON.stringify({ mode: 'submit', text: 'Call Initech', root: fakeHome, cwd: fakeHome }), env, encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).text, 'Call [CLIENT_1]');
});

test('tools aimed at an obfuscated copy go to the original file, with placeholders restored', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.project, 'team.yml'), 'owner: sarah.johnson@example.com\n');
  const copy = sb.helper({ mode: 'mention', path: 'team.yml' }).path;
  const original = path.join(sb.project, 'team.yml');
  const edit = sb.hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: copy, old_string: 'owner: [EMAIL_1]', new_string: 'owner: [EMAIL_1]\n# reviewed' } });
  assert.deepEqual(edit.hookSpecificOutput.updatedInput, { file_path: original, old_string: 'owner: sarah.johnson@example.com', new_string: 'owner: sarah.johnson@example.com\n# reviewed' });
  const bash = sb.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `wc -l "${copy}"` } });
  assert.equal(bash.hookSpecificOutput.updatedInput.command, `wc -l "${original}"`);
  assert.equal(sb.hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: original } }), null);
});
