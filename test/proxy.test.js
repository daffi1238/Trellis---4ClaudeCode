// Proxy mode: request obfuscation and response restoration (JSON and SSE). Fictional data only.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TRELLIS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-home-'));
const S = require('../lib/settings.js');
const { Vault } = require('../lib/vault.js');
const T = require('../lib/proxy-transform.js');

const settings = () => S.load('tool');

test('requests: system, messages, tool_use and tool_result are obfuscated; thinking and images are not', () => {
  const vault = new Vault(null);
  const body = {
    model: 'm',
    system: [{ type: 'text', text: 'CLAUDE.md: deploys go to ops@example.com', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'Bash', description: 'mail admin@example.com' }],
    messages: [
      { role: 'user', content: 'Write to laura.martinez@example.com' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'about laura.martinez@example.com', signature: 'sig' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'grep laura.martinez@example.com a.txt', data: 'ops@example.com' } }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt: laura.martinez@example.com' }] },
          { type: 'image', source: { type: 'base64', data: 'b3BzQGV4YW1wbGUuY29t' } }
        ]
      }
    ]
  };
  const { body: out, labels } = T.redactRequest(body, settings(), vault);
  const s = JSON.stringify(out);
  assert.equal(out.system[0].text, 'CLAUDE.md: deploys go to [EMAIL_1]');
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(out.messages[0].content, 'Write to [EMAIL_2]');
  assert.equal(out.messages[1].content[1].input.command, 'grep [EMAIL_2] a.txt');
  assert.equal(out.messages[1].content[1].input.data, '[EMAIL_1]', 'a field named data is not skipped');
  assert.equal(out.messages[2].content[0].content[0].text, 'a.txt: [EMAIL_2]');
  assert.equal(out.messages[1].content[0].thinking, 'about laura.martinez@example.com', 'signed thinking untouched');
  assert.equal(out.messages[2].content[1].source.data, 'b3BzQGV4YW1wbGUuY29t');
  assert.equal(out.tools[0].description, 'mail admin@example.com', 'tool definitions are not changed');
  assert.ok(labels.EMAIL >= 4);
  assert.doesNotMatch(s.replace(/"thinking":"[^"]*"/, ''), /laura|ops@/);
});

test('requests: known values are replaced even where no rule detects them', () => {
  const vault = new Vault(null);
  T.redactRequest({ messages: [{ role: 'user', content: 'ask Laura' }] }, settings(), vault);
  // A restored response comes back in the history glued to other text: "Laurax" is no longer a name.
  const { body } = T.redactRequest({ messages: [{ role: 'assistant', content: 'ask Laura and Laurax' }] }, settings(), vault);
  assert.equal(body.messages[0].content, 'ask [NAME_1] and [NAME_1]x');
});

test('requests are deterministic, so prompt caching keeps working', () => {
  const vault = new Vault(null);
  const req = { system: 'owner sarah.johnson@example.com', messages: [{ role: 'user', content: 'hi Sarah, sarah.johnson@example.com' }] };
  const a = JSON.stringify(T.redactRequest(req, settings(), vault).body);
  const b = JSON.stringify(T.redactRequest(req, settings(), vault).body);
  assert.equal(a, b);
});

test('JSON responses: text and tool_use restored, thinking untouched', () => {
  const vault = new Vault(null);
  T.redactRequest({ messages: [{ role: 'user', content: 'mail "ops"@example.com and ops@example.com' }] }, settings(), vault);
  const msg = {
    content: [
      { type: 'thinking', thinking: 'use [EMAIL_1]', signature: 's' },
      { type: 'text', text: 'Sending to [EMAIL_1].' },
      { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'mail [EMAIL_1]' } }
    ]
  };
  const out = T.restoreResponse(msg, vault);
  assert.equal(out.content[0].thinking, 'use [EMAIL_1]');
  assert.equal(out.content[1].text, 'Sending to ops@example.com.');
  assert.equal(out.content[2].input.command, 'mail ops@example.com');
});

function sse(events) {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function parseSse(text) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((e) => JSON.parse(/^data: (.*)$/m.exec(e)[1]));
}

test('SSE: placeholders split across deltas and chunks are restored, JSON stays valid', () => {
  const vault = new Vault(null);
  T.redactRequest({ messages: [{ role: 'user', content: 'quote "x" ops@example.com and a\\b@example.com' }] }, settings(), vault);
  const value2 = vault.valueOf('[EMAIL_2]');
  const stream = sse([
    ['message_start', { type: 'message_start', message: { content: [] } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think [EMAIL_1]' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Mail [EMA' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'IL_1] or [' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't', name: 'Bash', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command": "echo [EMAIL_' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '2]"}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 2 }],
    ['message_stop', { type: 'message_stop' }]
  ]);
  // Network chunks cut anywhere, even inside an event.
  const r = new T.SseRestorer(vault);
  let out = '';
  for (let i = 0; i < stream.length; i += 37) out += r.push(stream.slice(i, i + 37));
  out += r.end();
  const events = parseSse(out);
  const text = (i, f) => events.filter((e) => e.type === 'content_block_delta' && e.index === i).map((e) => e.delta[f]).join('');
  assert.equal(text(0, 'thinking'), 'think [EMAIL_1]');
  assert.equal(text(1, 'text'), 'Mail ops@example.com or [');
  assert.deepEqual(JSON.parse(text(2, 'partial_json')), { command: `echo ${value2}` });
  assert.equal(events.at(-1).type, 'message_stop');
});

test('outbound tool calls keep their placeholders (JSON and SSE)', () => {
  const vault = new Vault(null);
  T.redactRequest({ messages: [{ role: 'user', content: 'ops@example.com' }] }, settings(), vault);
  const st = { ...settings(), localMcpServers: ['sqlite'] };
  const msg = { content: [
    { type: 'tool_use', id: 'a', name: 'WebSearch', input: { query: '[EMAIL_1]' } },
    { type: 'tool_use', id: 'b', name: 'mcp__tracker__create', input: { title: '[EMAIL_1]' } },
    { type: 'tool_use', id: 'c', name: 'mcp__sqlite__query', input: { sql: '[EMAIL_1]' } },
    { type: 'tool_use', id: 'd', name: 'mcp__plugin_trellis_trellis__edit', input: { old_string: '[EMAIL_1]' } }
  ] };
  const out = T.restoreResponse(msg, vault, st).content.map((b) => Object.values(b.input)[0]);
  assert.deepEqual(out, ['[EMAIL_1]', '[EMAIL_1]', 'ops@example.com', 'ops@example.com']);

  const r = new T.SseRestorer(vault, st);
  const stream = sse([
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'w', name: 'WebFetch', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"url":"https://x.example/?q=[EMAIL_1]"}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }]
  ]);
  assert.equal(r.push(stream) + r.end(), stream);
});

test('structured placeholders: subnets and mail domains stay visible; everything restores', () => {
  const vault = new Vault(null);
  const s = { ...settings(), structuredPlaceholders: true };
  const text = 'hosts 10.20.30.40 and 10.20.30.41, gw 10.20.99.1; mail laura@northwind.example, sarah@northwind.example';
  const { body } = T.redactRequest({ messages: [{ role: 'user', content: text }] }, s, vault);
  const out = body.messages[0].content;
  assert.equal(out, 'hosts [NET_1].40 and [NET_1].41, gw [NET_2].1; mail [MAILBOX_1]@[DOMAIN_1], [MAILBOX_2]@[DOMAIN_1]');
  const reply = { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ping -c1 [NET_1].41 && mail [MAILBOX_2]@[DOMAIN_1]' } }] };
  const restored = T.restoreResponse(reply, vault, s);
  assert.equal(JSON.stringify(restored).includes('ping -c1 10.20.30.41 && mail sarah@northwind.example'), true);
  const plain = T.redactRequest({ messages: [{ role: 'user', content: 'host 10.20.30.40' }] }, settings(), new Vault(null)).body;
  assert.match(plain.messages[0].content, /^host \[IPV4_1\]$/, 'off by default');
});
