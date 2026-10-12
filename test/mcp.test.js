// scripts/mcp.js: the "edit" tool for text with placeholders, and the MCP handshake. Fictional data only.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MCP = path.join(__dirname, '..', 'scripts', 'mcp.js');
const HOOK = path.join(__dirname, '..', 'scripts', 'hook.js');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-proj-'));
  const env = { ...process.env, TRELLIS_HOME: home, CLAUDE_PROJECT_DIR: project };
  delete env.CLAUDE_PLUGIN_DATA;
  const hook = (input) => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: project, ...input }), env, encoding: 'utf8' });
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  const rpc = (...messages) => {
    const r = spawnSync(process.execPath, [MCP], { input: messages.map((m) => JSON.stringify(m)).join('\n') + '\n', env, encoding: 'utf8' });
    return r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  const call = (args, name = 'edit') => rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })[0].result;
  return { project, hook, rpc, call };
}

test('handshake and tool list', () => {
  const sb = sandbox();
  const [init, list] = sb.rpc(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' }
  );
  assert.equal(init.result.serverInfo.name, 'trellis');
  assert.deepEqual(list.result.tools.map((t) => t.name), ['edit', 'multi_edit']);
});

test('edits with placeholders apply the real values, and the reply has none', () => {
  const sb = sandbox();
  const file = path.join(sb.project, 'team.yml');
  fs.writeFileSync(file, 'db:\n  owner: Laura <laura.martinez@example.com>\nbilling: SARAH.JOHNSON@EXAMPLE.COM\n');
  const read = sb.hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: { file: { content: fs.readFileSync(file, 'utf8') } } });
  assert.equal(read.hookSpecificOutput.updatedToolOutput.file.content, 'db:\n  owner: [NAME_1] <[EMAIL_1]>\nbilling: [EMAIL_2]\n');

  const r = sb.call({ file_path: file, old_string: '  owner: [NAME_1] <[EMAIL_1]>\n', new_string: '  owner: [NAME_1] <[EMAIL_1]>\n  contact: [EMAIL_2]\n' });
  assert.equal(r.isError, undefined);
  assert.doesNotMatch(r.content[0].text, /example\.com|Laura/i);
  assert.equal(fs.readFileSync(file, 'utf8'), 'db:\n  owner: Laura <laura.martinez@example.com>\n  contact: SARAH.JOHNSON@EXAMPLE.COM\nbilling: SARAH.JOHNSON@EXAMPLE.COM\n');
});

test('same rules as Edit: not found, ambiguous, replace_all', () => {
  const sb = sandbox();
  const file = path.join(sb.project, 'a.txt');
  fs.writeFileSync(file, 'x a@example.com x a@example.com');
  sb.hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: 'a@example.com' } });
  assert.match(sb.call({ file_path: file, old_string: '[EMAIL_7]', new_string: 'y' }).content[0].text, /not found.*unknown placeholders: \[EMAIL_7\]/);
  assert.match(sb.call({ file_path: file, old_string: '[EMAIL_1]', new_string: 'b' }).content[0].text, /matches 2 times/);
  assert.equal(sb.call({ file_path: 'a.txt', old_string: 'x [EMAIL_1]', new_string: 'y', replace_all: true }).content[0].text, 'Edited a.txt: 2 replacements.');
  assert.equal(fs.readFileSync(file, 'utf8'), 'y y');
  assert.equal(sb.call({ file_path: 'missing.txt', old_string: 'a', new_string: 'b' }).isError, true);
});

test('multi_edit applies edits in order, all or nothing', () => {
  const sb = sandbox();
  const file = path.join(sb.project, 'c.env');
  fs.writeFileSync(file, 'OWNER=ops@example.com\nBACKUP=dba@example.com\n');
  sb.hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: { file: { content: fs.readFileSync(file, 'utf8') } } });
  const bad = sb.call({ file_path: file, edits: [{ old_string: 'OWNER=[EMAIL_1]', new_string: 'OWNER=[EMAIL_2]' }, { old_string: 'missing', new_string: 'x' }] }, 'multi_edit');
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /^edit 2: old_string not found/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'OWNER=ops@example.com\nBACKUP=dba@example.com\n', 'unchanged after a failed edit');
  const ok = sb.call({ file_path: file, edits: [
    { old_string: 'OWNER=[EMAIL_1]', new_string: 'OWNER=[EMAIL_2]' },
    { old_string: 'BACKUP=[EMAIL_2]', new_string: 'BACKUP=[EMAIL_1]' },
    { old_string: '[EMAIL_2]', new_string: '[EMAIL_2] # primary' }
  ] }, 'multi_edit');
  assert.equal(ok.isError, undefined, ok.content[0].text);
  assert.equal(fs.readFileSync(file, 'utf8'), 'OWNER=dba@example.com # primary\nBACKUP=ops@example.com\n');
});

test('NotebookEdit gets placeholders restored by the hook (its validation does not check the source)', () => {
  const sb = sandbox();
  sb.hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: 'a@example.com' } });
  const r = sb.hook({ hook_event_name: 'PreToolUse', tool_name: 'NotebookEdit', tool_input: { notebook_path: '/p/n.ipynb', cell_id: 'c1', new_source: 'to = "[EMAIL_1]"' } });
  assert.equal(r.hookSpecificOutput.updatedInput.new_source, 'to = "a@example.com"');
  assert.equal(r.hookSpecificOutput.updatedInput.cell_id, 'c1');
});

test('the hook leaves the Trellis tool alone and tells Claude to use it', () => {
  const sb = sandbox();
  sb.hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: 'a@example.com' } });
  assert.equal(sb.hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_trellis_trellis__edit', tool_input: { old_string: 'a@example.com' } }), null);
  const start = sb.hook({ hook_event_name: 'SessionStart', source: 'startup' });
  assert.match(start.hookSpecificOutput.additionalContext, /mcp__plugin_trellis_trellis__edit/);
});
