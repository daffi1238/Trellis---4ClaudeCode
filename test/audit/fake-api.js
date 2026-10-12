// A stand-in for the Anthropic API, for the traffic audit: it records every request Claude Code sends and answers
// from a script, so a real Claude Code with Trellis can run end to end with no account, cost or network.
//
// The main loop (a request with Claude Code's tools) gets the script's next step, counted by the server itself;
// past MAX_STEPS it ends the turn, so a script that never finishes cannot loop. The auto-mode classifier (its system
// prompt calls it a security monitor) is told to allow; every other request (titles...) gets a short text answer.
'use strict';

const http = require('node:http');

const MAX_STEPS = 12;

function sse(res, model, blocks) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  send('message_start', {
    message: { id: 'msg_audit', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }
  });
  blocks.forEach((b, index) => {
    if (b.type === 'tool_use') {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      // Split mid-way, as real streams do.
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 7) } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(7) } });
    } else {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    }
    send('content_block_stop', { index });
  });
  const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  send('message_stop', {});
  res.end();
}

// script(step, body) -> content blocks ({ type: 'text', text } or { type: 'tool_use', name, input }).
function start(script) {
  const requests = [];
  let toolIds = 0;
  let steps = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, body: raw });
      if (req.method !== 'POST' || !/^\/v1\/messages/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch (e) {
        // answered as a side request
      }
      if (/count_tokens/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ input_tokens: 100 }));
      }
      const system = JSON.stringify(body.system || '');
      const isClassifier = /security monitor/.test(system);
      const isMain = !isClassifier && Array.isArray(body.tools) && body.tools.some((t) => t.name === 'Bash');
      let blocks;
      if (isClassifier) blocks = [{ type: 'text', text: '<severity>5</severity>' }];
      else if (isMain) blocks = steps < MAX_STEPS ? script(steps++, body) : [{ type: 'text', text: 'Stopping.' }];
      blocks = blocks || [{ type: 'text', text: 'ok' }];
      for (const b of blocks) if (b.type === 'tool_use') b.id = `toolu_audit_${++toolIds}`;
      if (body.stream) return sse(res, body.model || 'audit', blocks);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_audit', type: 'message', role: 'assistant', model: body.model || 'audit',
        content: blocks.map((b) => (b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : b)),
        stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 }
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { start };
