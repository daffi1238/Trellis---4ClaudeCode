// Proxy mode, OpenAI Chat Completions format (Hermes Agent, DeepSeek, OpenRouter...). Fictional data only.
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
const O = require('../lib/proxy-openai.js');

const settings = (patch = {}) => ({ ...S.load('tool'), ...patch });

test('requests: text, parts, tool-call arguments (even escaped) and tool results are obfuscated', () => {
  const vault = new Vault(null);
  const body = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'Ops contact: ops@example.com' },
      { role: 'user', content: [{ type: 'text', text: 'Ping the server of Laura Martínez at 10.20.30.40' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
      { role: 'assistant', content: null, reasoning_content: 'host is 10.20.30.40', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'terminal', arguments: '{"command":"ping -c1 10.20.30.40","note":"Mart\\u00ednez"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'PING 10.20.30.40\nCookie: sessionid=abc123XYZ' }
    ],
    tools: [{ type: 'function', function: { name: 'terminal', description: 'mail admin@example.com for access' } }]
  };
  const { body: out } = O.redactChatRequest(body, settings(), vault);
  const s = JSON.stringify(out.messages);
  assert.equal(out.messages[0].content, 'Ops contact: [EMAIL_1]');
  assert.equal(out.messages[1].content[0].text, 'Ping the server of [NAME_1] [SURNAME_1] at [IPV4_1]');
  assert.equal(out.messages[1].content[1].image_url.url, 'data:image/png;base64,AAA');
  assert.deepEqual(JSON.parse(out.messages[2].tool_calls[0].function.arguments), { command: 'ping -c1 [IPV4_1]', note: '[SURNAME_1]' });
  assert.equal(out.messages[2].reasoning_content, 'host is [IPV4_1]');
  assert.equal(out.messages[3].content, 'PING [IPV4_1]\nCookie: sessionid=[COOKIE_1]');
  assert.doesNotMatch(s, /10\.20\.30\.40|Mart|abc123|ops@/);
  assert.equal(out.tools[0].function.description, 'mail admin@example.com for access', 'tool definitions are not changed');
  assert.equal(O.redactChatRequest(body, settings(), vault).body.messages[2].tool_calls[0].function.arguments, out.messages[2].tool_calls[0].function.arguments, 'deterministic');
});

test('responses: text and local tool calls restored; web and messaging tools keep placeholders', () => {
  const vault = new Vault(null);
  O.redactChatRequest({ messages: [{ role: 'user', content: 'host 10.20.30.40, mail "q"@example.com and ops@example.com' }] }, settings(), vault);
  const ip = '[IPV4_1]';
  const json = {
    choices: [{
      index: 0,
      message: {
        role: 'assistant', content: `Pinging ${ip}`, reasoning_content: `use ${ip}`,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'terminal', arguments: `{"command":"ping ${ip}"}` } },
          { id: 'b', type: 'function', function: { name: 'web_search', arguments: `{"query":"${ip}"}` } },
          { id: 'c', type: 'function', function: { name: 'send_message', arguments: `{"to":"[EMAIL_2]"}` } }
        ]
      }
    }]
  };
  const out = O.restoreChatResponse(json, vault, settings()).choices[0].message;
  assert.equal(out.content, 'Pinging 10.20.30.40');
  assert.equal(out.reasoning_content, 'use 10.20.30.40');
  assert.deepEqual(out.tool_calls.map((t) => JSON.parse(t.function.arguments)), [{ command: 'ping 10.20.30.40' }, { query: ip }, { to: '[EMAIL_2]' }]);
  // An allowlist: only the named tools get real values.
  const only = O.restoreChatResponse(json, vault, settings({ proxyRestoreTools: ['read_file'] })).choices[0].message;
  assert.equal(JSON.parse(only.tool_calls[0].function.arguments).command, `ping ${ip}`);
});

test('the tool policy: built-in patterns, extra patterns, local MCP servers, allowlist', () => {
  const st = settings({ proxyNoRestoreTools: ['deploy_*'], localMcpServers: ['sqlite'] });
  const yes = ['Bash', 'Edit', 'terminal', 'read_file', 'execute_code', 'mcp__sqlite__query', 'mcp__plugin_trellis_trellis__edit'];
  const no = ['WebFetch', 'WebSearch', 'mcp__github__create_issue', 'web_search', 'web_extract', 'browser_navigate', 'send_message', 'email_send', 'http_request', 'google_search', 'url_fetch', 'deploy_prod'];
  for (const n of yes) assert.equal(T.restoresTool(n, st), true, n);
  for (const n of no) assert.equal(T.restoresTool(n, st), false, n);
});

function sse(chunks) {
  return chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
}
const chunk = (delta, finish = null) => ({ id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });

test('SSE: placeholders split across chunks are restored in text and in local tool arguments', () => {
  const vault = new Vault(null);
  O.redactChatRequest({ messages: [{ role: 'user', content: 'host 10.20.30.40 owner a"b@example.com' }] }, settings(), vault);
  const stream = sse([
    chunk({ role: 'assistant', content: 'Checking [IPV' }),
    chunk({ content: '4_1] now' }),
    chunk({ tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'terminal', arguments: '{"command":"ping [IPV4' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '_1]"}' } }] }),
    chunk({ tool_calls: [{ index: 1, id: 't2', type: 'function', function: { name: 'web_search', arguments: '{"q":"[IPV4_1]"}' } }] }),
    chunk({ content: ' for [' }),
    chunk({}, 'tool_calls'),
    '[DONE]'
  ]);
  const r = new O.ChatSseRestorer(vault, settings());
  let out = '';
  for (let i = 0; i < stream.length; i += 29) out += r.push(stream.slice(i, i + 29));
  out += r.end();
  const events = out.split('\n\n').filter(Boolean).map((e) => e.slice(6));
  assert.equal(events.at(-1), '[DONE]');
  const parsed = events.slice(0, -1).map((e) => JSON.parse(e));
  const content = parsed.map((c) => c.choices[0].delta.content || '').join('');
  const args = (n) => parsed.flatMap((c) => c.choices[0].delta.tool_calls || []).filter((t) => t.index === n).map((t) => t.function?.arguments || '').join('');
  assert.equal(content, 'Checking 10.20.30.40 now for [');
  assert.deepEqual(JSON.parse(args(0)), { command: 'ping 10.20.30.40' });
  assert.deepEqual(JSON.parse(args(1)), { q: '[IPV4_1]' });
  assert.equal(parsed.at(-1).choices[0].finish_reason, 'tool_calls');
});
