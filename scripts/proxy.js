#!/usr/bin/env node
// Trellis proxy mode (experimental): a local proxy between Claude Code and the model API.
//
//   node scripts/proxy.js [--port 8788] [--upstream https://api.anthropic.com]
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8788 claude
//
// Messages API requests are obfuscated before they leave this machine, whatever put the data there: prompts,
// CLAUDE.md, @ attachments, git status, tool results and errors, and Claude Code's own internal calls (such as the
// auto-mode classifier). Responses are restored, so Claude Code and its tools work with the real values.
// Every other request is passed through untouched. Logs show counts per label, never values.
'use strict';

const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const S = require('../lib/settings.js');
const Vault = require('../lib/vault.js');
const R = require('../lib/redact.js');
const T = require('../lib/proxy-transform.js');

function parseArgs(argv) {
  const args = { port: Number(process.env.TRELLIS_PROXY_PORT) || 8788, upstream: process.env.TRELLIS_UPSTREAM || 'https://api.anthropic.com' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--upstream') args.upstream = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

const vaultFile = () => path.join(S.dataDir(), 'vault', 'proxy.json');
const isMessages = (url) => /^\/v1\/messages(?:\/count_tokens)?(?:\?|$)/.test(url);
const isGeneration = (url) => /^\/v1\/messages(?:\?|$)/.test(url);

function log(msg) {
  process.stderr.write(`[trellis-proxy] ${msg}\n`);
}

function fail(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Trellis proxy: ${message}` } }));
}

function forward(upstream, req, body, onResponse, onError) {
  const target = new URL(req.url, upstream);
  const headers = { ...req.headers, host: target.host };
  delete headers['accept-encoding']; // plain bodies, so responses can be restored
  delete headers['content-length'];
  if (body) headers['content-length'] = Buffer.byteLength(body);
  const lib = target.protocol === 'http:' ? http : https;
  const up = lib.request(target, { method: req.method, headers }, onResponse);
  up.on('error', onError);
  up.end(body);
}

function handle(upstream, req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    const onError = (e) => fail(res, 502, `upstream error (${e.code || e.message})`);

    if (req.method !== 'POST' || !isMessages(req.url)) {
      return forward(upstream, req, body.length ? body : null, (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      }, onError);
    }

    // Fail closed: if the body cannot be obfuscated, it is not sent.
    let vault;
    let settings;
    try {
      const json = JSON.parse(body.toString('utf8'));
      settings = S.load('tool');
      if (!settings.enabled) {
        vault = new Vault.Vault(null); // disabled: nothing obfuscated, nothing restored
      } else {
        const result = Vault.updateFile(vaultFile(), (v) => {
          vault = v;
          return T.redactRequest(json, settings, v);
        });
        body = Buffer.from(JSON.stringify(result.body));
        const found = R.describe(result.labels);
        if (found) log(`${req.url.split('?')[0]}: obfuscated ${found}`);
      }
    } catch (e) {
      log(`blocked a request that could not be obfuscated: ${e.message}`);
      return fail(res, 500, 'the request could not be obfuscated, so it was not sent');
    }

    forward(upstream, req, body, (up) => {
      const type = String(up.headers['content-type'] || '');
      const headers = { ...up.headers };
      delete headers['content-length'];
      if (!isGeneration(req.url) || up.statusCode !== 200) {
        res.writeHead(up.statusCode, up.headers);
        return up.pipe(res);
      }
      up.setEncoding('utf8');
      if (type.includes('text/event-stream')) {
        const sse = new T.SseRestorer(vault, settings);
        res.writeHead(up.statusCode, headers);
        up.on('data', (c) => res.write(sse.push(c)));
        up.on('end', () => res.end(sse.end()));
        return;
      }
      let text = '';
      up.on('data', (c) => (text += c));
      up.on('end', () => {
        let out = text;
        try {
          out = JSON.stringify(T.restoreResponse(JSON.parse(text), vault, settings));
        } catch (e) {
          // not JSON: passed through
        }
        headers['content-length'] = Buffer.byteLength(out);
        res.writeHead(up.statusCode, headers);
        res.end(out);
      });
    }, onError);
  });
}

function main() {
  const { port, upstream } = parseArgs(process.argv.slice(2));
  const server = http.createServer((req, res) => handle(upstream, req, res));
  server.listen(port, '127.0.0.1', () => {
    log(`listening on http://127.0.0.1:${port} -> ${upstream}`);
    log(`start Claude Code with ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`);
  });
}

if (require.main === module) main();

module.exports = { handle };
