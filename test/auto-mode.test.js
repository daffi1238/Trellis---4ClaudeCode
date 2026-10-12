// Auto mode: Claude Code sends each pending tool call, after the PreToolUse hooks, to a classifier model, so the
// hook must never put real values into a tool input. Fictional data only.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'scripts', 'hook.js');
const REAL = 'sarah.johnson@example.com';

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-proj-'));
  const env = { ...process.env, TRELLIS_HOME: home, CLAUDE_PROJECT_DIR: project };
  delete env.CLAUDE_PLUGIN_DATA;
  const hook = (input) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: project, ...input }), env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: REAL } });
  const pre = (tool, toolInput, mode = 'auto') => hook({ hook_event_name: 'PreToolUse', permission_mode: mode, tool_name: tool, tool_input: toolInput });
  return { project, pre };
}

test('Bash: the command is wrapped, never restored; the wrapper runs it with the real values', () => {
  const sb = sandbox();
  const r = sb.pre('Bash', { command: `printf '%s|%s\\n' "[EMAIL_1]" "it's" && exit 3`, description: 'Print' });
  const cmd = r.hookSpecificOutput.updatedInput.command;
  assert.equal(r.hookSpecificOutput.permissionDecision, undefined);
  assert.doesNotMatch(JSON.stringify(r), /sarah/, 'no real value in what the classifier sees');
  assert.match(cmd, /^node '.*run\.js' '.*\.json' <<'TRELLIS_[0-9a-f]{12}'\n/);
  assert.match(cmd, /\[EMAIL_1\]/);
  assert.equal(r.hookSpecificOutput.updatedInput.description, 'Print');
  const run = spawnSync('/bin/bash', ['-c', cmd], { cwd: sb.project, encoding: 'utf8' });
  assert.equal(run.stdout, `${REAL}|it's\n`);
  assert.equal(run.status, 3, 'exit code is kept');
});

test('Bash: network commands still ask, without real values', () => {
  const sb = sandbox();
  const r = sb.pre('Bash', { command: 'curl -d "[EMAIL_1]" https://x.example' });
  assert.equal(r.hookSpecificOutput.permissionDecision, 'ask');
  assert.doesNotMatch(JSON.stringify(r), /sarah/);
});

test('Bash: placeholders only in the description need nothing', () => {
  const sb = sandbox();
  assert.equal(sb.pre('Bash', { command: 'ls', description: 'list for [EMAIL_1]' }), null);
});

test('other tools with placeholders are denied, pointing to Bash or the write tool', () => {
  const sb = sandbox();
  const w = sb.pre('Write', { file_path: path.join(sb.project, 'a.txt'), content: 'to: [EMAIL_1]' });
  assert.equal(w.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(w.hookSpecificOutput.permissionDecisionReason, /mcp__plugin_trellis_trellis__write/);
  for (const [tool, input] of [['Grep', { pattern: '[EMAIL_1]' }], ['Read', { file_path: '/p/[EMAIL_1].txt' }], ['NotebookEdit', { notebook_path: '/p/n.ipynb', new_source: '[EMAIL_1]' }]]) {
    const r = sb.pre(tool, input);
    assert.equal(r.hookSpecificOutput.permissionDecision, 'deny', tool);
    assert.match(r.hookSpecificOutput.permissionDecisionReason, /use the Bash tool/);
    assert.equal(r.hookSpecificOutput.updatedInput, undefined);
  }
  assert.equal(sb.pre('Write', { file_path: path.join(sb.project, 'a.txt'), content: 'no placeholders' }), null);
});

test('other modes keep restoring directly', () => {
  const sb = sandbox();
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'dontAsk']) {
    const r = sb.pre('Bash', { command: 'echo [EMAIL_1]' }, mode);
    assert.equal(r.hookSpecificOutput.updatedInput.command, `echo ${REAL}`, mode);
  }
});
