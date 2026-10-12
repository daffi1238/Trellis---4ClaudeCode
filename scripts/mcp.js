#!/usr/bin/env node
// Local MCP server with one tool, "edit": the Edit tool for text that contains Trellis placeholders.
//
// Claude Code checks that an Edit's old_string exists in the file before any hook runs, so an Edit written with
// placeholders ("[EMAIL_1]") always fails: the file has the real value. This tool restores the placeholders and
// applies the edit itself, on this machine. MCP over stdio, newline-delimited JSON-RPC, no dependencies.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const Vault = require('../lib/vault.js');
const R = require('../lib/redact.js');

const PROTOCOL = '2025-06-18';

const EDIT_TOOL = {
  name: 'edit',
  description:
    'Replace text in a file when old_string or new_string contain Trellis placeholders such as [EMAIL_1]. ' +
    'Same semantics as the Edit tool: old_string must match exactly once unless replace_all is true. ' +
    'Placeholders are replaced by the real values on the user\'s machine before the edit is applied. ' +
    'Use the regular Edit tool when no placeholders are involved.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path of the file to modify' },
      old_string: { type: 'string', description: 'The text to replace (may contain placeholders)' },
      new_string: { type: 'string', description: 'The replacement text (may contain placeholders)' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' }
    },
    required: ['file_path', 'old_string', 'new_string']
  },
  annotations: { title: 'Edit with placeholders', destructiveHint: true, openWorldHint: false }
};

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function count(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

// Returns a short message; never includes file contents or restored values (it goes back to Claude).
function edit(args) {
  const { file_path: rawPath, old_string: rawOld, new_string: rawNew, replace_all: all = false } = args || {};
  if (typeof rawPath !== 'string' || typeof rawOld !== 'string' || typeof rawNew !== 'string') {
    throw new Error('file_path, old_string and new_string must be strings');
  }
  if (rawOld === rawNew) throw new Error('old_string and new_string are the same');
  const vault = Vault.read(projectDir());
  const file = path.resolve(projectDir(), R.restoreText(rawPath, vault).text);
  const oldS = R.restoreText(rawOld, vault).text;
  const newS = R.restoreText(rawNew, vault).text;
  const unknown = [...new Set((rawOld + rawNew).match(R.TOKEN_RE) || [])].filter((t) => vault.valueOf(t) === undefined);
  const text = fs.readFileSync(file, 'utf8');
  if (!oldS) throw new Error('old_string is empty');
  const n = count(text, oldS);
  if (n === 0) {
    throw new Error(`old_string not found in the file${unknown.length ? ` (unknown placeholders: ${unknown.join(', ')})` : ''}. Read the file again and copy the text exactly.`);
  }
  if (n > 1 && !all) throw new Error(`old_string matches ${n} times; add more context or set replace_all.`);
  const out = all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
  fs.writeFileSync(file, out);
  return `Edited ${rawPath}: ${all ? n : 1} replacement${(all ? n : 1) === 1 ? '' : 's'}.`;
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function fail(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'trellis', version: '0.1.0' }
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: [EDIT_TOOL] });
    case 'tools/call': {
      if (params?.name !== 'edit') return fail(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        return reply(id, { content: [{ type: 'text', text: edit(params.arguments) }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: e.code ? `${e.code}: cannot edit the file` : e.message }], isError: true });
      }
    }
    default:
      if (isRequest) fail(id, -32601, `Method not found: ${method}`);
  }
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      return fail(null, -32700, 'Parse error');
    }
    handle(msg);
  });
}

module.exports = { edit, handle, EDIT_TOOL };
