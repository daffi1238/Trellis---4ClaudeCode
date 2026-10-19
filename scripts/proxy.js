#!/usr/bin/env node
// Trellis proxy mode (experimental): a local proxy between Claude Code and the model API.
//
//   node scripts/proxy.js [--port 8788] [--upstream https://api.anthropic.com]
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8788 claude
//
// /trellis:proxy prints the exact command, with the plugin's data directory (TRELLIS_HOME), so the proxy uses the
// same settings and memory as the plugin. While it runs, the plugin's hooks see it and leave obfuscation to it.
//
// Messages API requests are obfuscated before they leave this machine, whatever put the data there: prompts,
// CLAUDE.md, @ attachments, git status, tool results and errors, and Claude Code's own internal calls (such as the
// auto-mode classifier). Responses are restored, so Claude Code and its tools work with the real values.
// Every other request is passed through untouched. Logs show counts per label, never values.
'use strict';

const http = require('node:http');
const https = require('node:https');
const S = require('../lib/settings.js');
const Vault = require('../lib/vault.js');
const R = require('../lib/redact.js');
const T = require('../lib/proxy-transform.js');
const O = require('../lib/proxy-openai.js');
const ProxyState = require('../lib/proxy-state.js');

function parseArgs(argv) {
  const args = { port: Number(process.env.TRELLIS_PROXY_PORT) || 8788, upstream: process.env.TRELLIS_UPSTREAM || 'https://api.anthropic.com' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--upstream') args.upstream = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

// The two request formats the proxy obfuscates: Anthropic's Messages API (Claude Code) and OpenAI's Chat
// Completions (Hermes Agent, DeepSeek, OpenRouter...). Every other request is passed through untouched.
const FORMATS = {
  messages: {
    match: (url) => /^\/v1\/messages(?:\/count_tokens)?(?:\?|$)/.test(url),
    generates: (url) => /^\/v1\/messages(?:\?|$)/.test(url),
    redact: T.redactRequest,
    restore: T.restoreResponse,
    Stream: T.SseRestorer
  },
  chat: {
    match: (url) => /^(?:\/v1)?\/chat\/completions(?:\?|$)/.test(url),
    generates: () => true,
    redact: O.redactChatRequest,
    restore: O.restoreChatResponse,
    Stream: O.ChatSseRestorer
  }
};
const formatOf = (req) => (req.method === 'POST' ? Object.values(FORMATS).find((f) => f.match(req.url)) : undefined);

// The upstream URL may carry a path (https://openrouter.ai/api/v1): the request's path goes after it, without
// repeating /v1.
function targetUrl(upstream, reqUrl) {
  const u = new URL(upstream);
  const base = u.pathname.replace(/\/+$/, '');
  const path = base.endsWith('/v1') && reqUrl.startsWith('/v1/') ? reqUrl.slice(3) : reqUrl;
  return new URL(u.origin + base + path);
}

function log(msg) {
  process.stderr.write(`[trellis-proxy] ${msg}\n`);
}

function fail(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Trellis proxy: ${message}` } }));
}

function forward(upstream, req, body, onResponse, onError) {
  const target = targetUrl(upstream, req.url);
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

    const format = formatOf(req);
    if (!format) {
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
        const result = Vault.updateFile(ProxyState.vaultFile(), (v) => {
          vault = v;
          return format.redact(json, settings, v);
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
      if (!format.generates(req.url) || up.statusCode !== 200) {
        res.writeHead(up.statusCode, up.headers);
        return up.pipe(res);
      }
      up.setEncoding('utf8');
      if (type.includes('text/event-stream')) {
        const sse = new format.Stream(vault, settings);
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
          out = JSON.stringify(format.restore(JSON.parse(text), vault, settings));
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
    const url = `http://127.0.0.1:${port}`;
    ProxyState.write({ url, upstream, startedAt: new Date().toISOString() });
    log(`listening on ${url} -> ${upstream} (data: ${S.dataDir()})`);
    log(`start Claude Code with ANTHROPIC_BASE_URL=${url}`);
  });
  const stop = () => {
    ProxyState.clear();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', () => ProxyState.clear());
}

if (require.main === module) main();

module.exports = { handle, targetUrl };
