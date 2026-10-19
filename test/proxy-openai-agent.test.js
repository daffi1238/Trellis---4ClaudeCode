// End to end, OpenAI format: an agent loop (as Hermes Agent runs one) talks to the Trellis proxy, which forwards to a
// recording stand-in for an OpenAI-compatible API (DeepSeek, OpenRouter...). The model never sees an original
// value; the agent's local tool runs with the real ones; its web tool only ever gets placeholders. Fictional data.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.TRELLIS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-home-'));
delete process.env.ANTHROPIC_BASE_URL;
const { handle } = require('../scripts/proxy.js');

const ORIGINALS = ['10.20.30.40', 'Laura', 'Martínez', 'laura.martinez@example.com', 'abc123XYZ'];

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

// The model: asks for a ping, then a web search, then answers; always about the placeholder it was given.
function fakeModel() {
  const requests = [];
  let step = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body: raw });
      const ip = (raw.match(/\[IPV4_\d+\]/) || ['[none]'])[0];
      const delta = [
        [{ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'terminal', arguments: `{"command":"ping -c1 ${ip.slice(0, 4)}` } }] },
          { tool_calls: [{ index: 0, function: { arguments: `${ip.slice(4)}"}` } }] }],
        [{ content: 'Looking it up' }, { tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'web_search', arguments: `{"query":"who owns ${ip}"}` } }] }],
        [{ content: `Host ${ip.slice(0, 5)}` }, { content: `${ip.slice(5)} answered.` }]
      ][Math.min(step++, 2)];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const d of delta) res.write(`data: ${JSON.stringify({ id: 'r', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: d, finish_reason: null }] })}\n\n`);
      const finish = step <= 2 ? 'tool_calls' : 'stop';
      res.write(`data: ${JSON.stringify({ id: 'r', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return { server, requests };
}

// One streamed completion, assembled the way an OpenAI client does.
async function complete(base, messages) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-audit-not-a-real-key' },
    body: JSON.stringify({ model: 'deepseek-chat', stream: true, messages, tools: [{ type: 'function', function: { name: 'terminal' } }, { type: 'function', function: { name: 'web_search' } }] })
  });
  const text = await res.text();
  let content = '';
  const calls = [];
  for (const ev of text.split('\n\n')) {
    const data = ev.replace(/^data: /, '');
    if (!data || data === '[DONE]') continue;
    const d = JSON.parse(data).choices[0].delta;
    content += d.content || '';
    for (const tc of d.tool_calls || []) {
      calls[tc.index] ??= { id: tc.id, type: 'function', function: { name: tc.function?.name, arguments: '' } };
      calls[tc.index].function.arguments += tc.function?.arguments || '';
    }
  }
  return { content, calls };
}

test('an OpenAI-format agent: the model sees placeholders, local tools real values, web tools placeholders', async () => {
  const model = fakeModel();
  const upstream = await listen(model.server);
  const proxy = http.createServer((req, res) => handle(upstream + '/v1', req, res));
  const base = await listen(proxy);
  const ran = { terminal: [], web_search: [] };
  try {
    const messages = [{ role: 'user', content: 'Check the host 10.20.30.40 of Laura Martínez <laura.martinez@example.com>' }];
    let answer = '';
    for (let turn = 0; turn < 5; turn++) {
      const { content, calls } = await complete(base, messages);
      messages.push({ role: 'assistant', content: content || null, ...(calls.length && { tool_calls: calls }) });
      if (!calls.length) {
        answer = content;
        break;
      }
      for (const c of calls) {
        const args = JSON.parse(c.function.arguments);
        ran[c.function.name].push(args);
        // The terminal "runs" the command; its output carries the IP and a session cookie.
        const output = c.function.name === 'terminal' ? `PING ${args.command.split(' ').pop()}: 1 packets\nSet-Cookie: sid=abc123XYZ; Path=/` : 'no results';
        messages.push({ role: 'tool', tool_call_id: c.id, content: output });
      }
    }
    assert.deepEqual(ran.terminal, [{ command: 'ping -c1 10.20.30.40' }], 'the local tool ran with the real value');
    assert.match(ran.web_search[0].query, /^who owns \[IPV4_\d+\]$/, 'the web tool only got a placeholder');
    assert.equal(answer, 'Host 10.20.30.40 answered.');
    assert.equal(model.requests.length, 3);
    for (const r of model.requests) {
      assert.equal(r.url, '/v1/chat/completions');
      assert.equal(r.auth, 'Bearer sk-audit-not-a-real-key', 'the API key is passed on');
      for (const v of ORIGINALS) assert.ok(!r.body.includes(v), `the model was sent "${v}"`);
    }
  } finally {
    proxy.close();
    model.server.close();
  }
});
