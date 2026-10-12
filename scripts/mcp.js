#!/usr/bin/env node
// Local MCP server with tools that accept Trellis placeholders: "edit", "multi_edit" and "write".
//
// Claude Code checks that an Edit's old_string exists in the file before any hook runs, so an Edit written with
// placeholders ("[EMAIL_1]") always fails: the file has the real value. These tools restore the placeholders and
// apply the edits themselves, on this machine. In auto mode, "write" replaces the Write tool for the same reason the
// hook never restores inputs there: the auto-mode classifier would see the real values.
// MCP over stdio, newline-delimited JSON-RPC, no dependencies.
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

const MULTI_EDIT_TOOL = {
  name: 'multi_edit',
  description:
    'Apply several edits to one file at once, when they contain Trellis placeholders such as [EMAIL_1]. ' +
    'Edits are applied in order, each to the result of the previous one, with the same rules as the edit tool. ' +
    'All or nothing: if any edit fails, the file is left unchanged.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path of the file to modify' },
      edits: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' }
          },
          required: ['old_string', 'new_string']
        }
      }
    },
    required: ['file_path', 'edits']
  },
  annotations: { title: 'Multi-edit with placeholders', destructiveHint: true, openWorldHint: false }
};

const WRITE_TOOL = {
  name: 'write',
  description:
    'Write a file whose content contains Trellis placeholders such as [EMAIL_1] (creates or overwrites it). ' +
    'Placeholders are replaced by the real values on the user\'s machine. Use it when Trellis says Write cannot be used.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path of the file to write' },
      content: { type: 'string', description: 'The content (may contain placeholders)' }
    },
    required: ['file_path', 'content']
  },
  annotations: { title: 'Write with placeholders', destructiveHint: true, openWorldHint: false }
};

const TOOLS = [EDIT_TOOL, MULTI_EDIT_TOOL, WRITE_TOOL];

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function count(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

// Applies edits ({ old_string, new_string, replace_all }) to a file, all or nothing. Returns a short message
// that never includes file contents or restored values (it goes back to Claude).
function applyEdits(rawPath, edits) {
  if (typeof rawPath !== 'string') throw new Error('file_path must be a string');
  if (!Array.isArray(edits) || !edits.length) throw new Error('edits must be a non-empty array');
  const vault = Vault.read(projectDir());
  const file = path.resolve(projectDir(), R.restoreText(rawPath, vault).text);
  let text = fs.readFileSync(file, 'utf8');
  let total = 0;
  edits.forEach((e, i) => {
    const where = edits.length > 1 ? `edit ${i + 1}: ` : '';
    const { old_string: rawOld, new_string: rawNew, replace_all: all = false } = e || {};
    if (typeof rawOld !== 'string' || typeof rawNew !== 'string') throw new Error(`${where}old_string and new_string must be strings`);
    if (!rawOld) throw new Error(`${where}old_string is empty`);
    if (rawOld === rawNew) throw new Error(`${where}old_string and new_string are the same`);
    const oldS = R.restoreText(rawOld, vault).text;
    const newS = R.restoreText(rawNew, vault).text;
    const n = count(text, oldS);
    if (n === 0) {
      const unknown = [...new Set((rawOld + rawNew).match(R.TOKEN_RE) || [])].filter((t) => vault.valueOf(t) === undefined);
      throw new Error(`${where}old_string not found in the file${unknown.length ? ` (unknown placeholders: ${unknown.join(', ')})` : ''}. Read the file again and copy the text exactly.`);
    }
    if (n > 1 && !all) throw new Error(`${where}old_string matches ${n} times; add more context or set replace_all.`);
    text = all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
    total += all ? n : 1;
  });
  fs.writeFileSync(file, text);
  return `Edited ${rawPath}: ${total} replacement${total === 1 ? '' : 's'}.`;
}

function edit(args) {
  const { file_path: p, ...one } = args || {};
  return applyEdits(p, [one]);
}

function multiEdit(args) {
  return applyEdits(args?.file_path, args?.edits);
}

function write(args) {
  const { file_path: rawPath, content } = args || {};
  if (typeof rawPath !== 'string' || typeof content !== 'string') throw new Error('file_path and content must be strings');
  const vault = Vault.read(projectDir());
  const file = path.resolve(projectDir(), R.restoreText(rawPath, vault).text);
  const existed = fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, R.restoreText(content, vault).text);
  return `${existed ? 'Overwrote' : 'Created'} ${rawPath}.`;
}

const HANDLERS = { edit, multi_edit: multiEdit, write };

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
        serverInfo: { name: 'trellis', version: '0.2.0' }
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      const run = HANDLERS[params?.name];
      if (!run) return fail(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        return reply(id, { content: [{ type: 'text', text: run(params.arguments) }] });
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

module.exports = { edit, multiEdit, write, handle, TOOLS };
