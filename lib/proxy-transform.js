// Proxy mode: Messages API requests are obfuscated on their way out and responses restored on their way back.
//
// Requests: every string in `system` and `messages` goes through the rules, word lists and memory, and then through
// a literal pass that replaces every value already in the vault. The literal pass matters because responses are
// restored: Claude Code stores the real values and sends them back in the history, sometimes in a context where
// no rule would detect them again ("[NAME_1]x" comes back as "Laurax").
//
// Tool calls to tools that send data off the machine (WebFetch, WebSearch, MCP servers not declared local) are not
// restored: they keep the placeholders, as with the hooks.
//
// Thinking blocks are never touched in either direction: they are signed, and the API rejects a modified one. The
// model only ever sees placeholders, so its thinking only contains placeholders.
'use strict';

const R = require('./redact.js');
const Engine = require('./obfuscator.js');

const SKIP_BLOCKS = new Set(['thinking', 'redacted_thinking', 'image']);
// Signatures and opaque or binary payloads (images, PDFs and redacted thinking are skipped by block type).
const SKIP_KEYS = new Set(['signature', 'encrypted_content', 'encrypted_index', 'base64']);
const MIN_LITERAL = 3;

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SKIP_KEYS.has(k) ? v : mapStrings(v, fn);
    return out;
  }
  return value;
}

// Applies fn to the text of a content block (or a plain string content).
function mapContent(content, fn) {
  if (typeof content === 'string') return fn(content);
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== 'object' || SKIP_BLOCKS.has(block.type)) return block;
    if (block.type === 'document' && block.source?.type === 'base64') return block;
    if (block.type === 'tool_result') return { ...block, content: mapContent(block.content, fn) };
    if (block.type === 'text') return { ...block, text: fn(block.text) };
    // tool_use, server tool blocks, documents with text...: every string except signatures and binary data.
    return mapStrings(block, fn);
  });
}

function mapRequest(body, fn) {
  const out = { ...body };
  if (typeof out.system === 'string') out.system = fn(out.system);
  else if (Array.isArray(out.system)) out.system = out.system.map((b) => (b && b.type === 'text' ? { ...b, text: fn(b.text) } : b));
  if (Array.isArray(out.messages)) out.messages = out.messages.map((m) => (m && m.content !== undefined ? { ...m, content: mapContent(m.content, fn) } : m));
  return out;
}

// Regex matching every value in the vault, longest first.
function literalRegex(vault) {
  const values = [...new Set(Object.values(vault.data.tokens).map((t) => t.value))].filter((v) => v.length >= MIN_LITERAL);
  if (!values.length) return null;
  values.sort((a, b) => b.length - a.length);
  return new RegExp(values.map(Engine.escapeRegex).join('|'), 'g');
}

// Returns { body, labels }. labels counts what the rules found ({ EMAIL: 2 }); the literal pass is not counted.
function redactRequest(body, settings, vault) {
  const labels = {};
  let out = mapRequest(body, (s) => R.obfuscateText(s, settings, vault, labels).text);
  const re = literalRegex(vault);
  if (re) {
    const byValue = new Map(Object.entries(vault.data.tokens).map(([token, { label, value }]) => [value, token]));
    out = mapRequest(out, (s) => (typeof s === 'string' && s ? s.replace(re, (v) => byValue.get(v) || v) : s));
  }
  return { body: out, labels };
}

// ---------- Responses ----------

// Tools that send data off the machine never get real values: Claude Code's web tools and MCP servers, and the
// usual names of web, browser and messaging tools in other agents (Hermes, OpenAI-style function tools...).
// settings.proxyNoRestoreTools adds patterns; settings.proxyRestoreTools, when set, is the only tools that do.
const NO_RESTORE = ['WebFetch', 'WebSearch', 'mcp__*', 'web_*', 'browser_*', 'send_*', 'email_*', 'http_*', 'fetch_*', '*_search', '*_fetch'];

const globCache = new Map();
function glob(pattern) {
  if (!globCache.has(pattern)) globCache.set(pattern, new RegExp('^' + String(pattern).split('*').map(Engine.escapeRegex).join('.*') + '$', 'i'));
  return globCache.get(pattern);
}
const matchesAny = (name, patterns) => (Array.isArray(patterns) ? patterns : []).some((p) => typeof p === 'string' && glob(p).test(name));

// Whether a tool call may receive the real values (it runs on this machine).
function restoresTool(name, settings) {
  const n = String(name || '');
  if (Array.isArray(settings?.proxyRestoreTools) && settings.proxyRestoreTools.length) return matchesAny(n, settings.proxyRestoreTools);
  const mcp = /^mcp__(.+?)__/.exec(n);
  if (mcp && (/^plugin_trellis_/.test(mcp[1]) || (settings?.localMcpServers || []).includes(mcp[1]))) return true;
  return !matchesAny(n, NO_RESTORE) && !matchesAny(n, settings?.proxyNoRestoreTools);
}

function restoreJsonString(fragment, vault) {
  R.TOKEN_RE.lastIndex = 0;
  return fragment.replace(R.TOKEN_RE, (all) => {
    const v = vault.valueOf(all);
    return v === undefined ? all : JSON.stringify(v).slice(1, -1);
  });
}

// A whole (non-streaming) Messages response.
function restoreResponse(msg, vault, settings) {
  if (!msg || !Array.isArray(msg.content)) return msg;
  return {
    ...msg,
    content: msg.content.map((b) => {
      if (!b || SKIP_BLOCKS.has(b.type)) return b;
      if (b.type === 'text') return { ...b, text: R.restoreText(b.text, vault).text };
      if (b.type === 'tool_use') return restoresTool(b.name, settings) ? { ...b, input: R.restoreDeep(b.input, vault).value } : b;
      return b;
    })
  };
}

// The longest tail that could still become a placeholder ("[EMA"); it is held back until the next delta.
const PARTIAL_RE = /\[[A-Z0-9_]{0,60}$/;

// Streaming (SSE) responses. Placeholders can be split across deltas, so text that might be the start of one is
// held back until it is complete or the block ends.
class SseRestorer {
  constructor(vault, settings) {
    this.vault = vault;
    this.settings = settings;
    this.buffer = '';
    this.blocks = new Map(); // index -> { type, pending }
  }

  // Raw bytes in, raw SSE text out.
  push(chunk) {
    this.buffer += chunk;
    let out = '';
    let i;
    while ((i = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, i + 2);
      this.buffer = this.buffer.slice(i + 2);
      out += this.event(raw);
    }
    return out;
  }

  end() {
    const rest = this.buffer;
    this.buffer = '';
    return rest;
  }

  event(raw) {
    const data = /^data: ?(.*)$/m.exec(raw)?.[1];
    if (!data) return raw;
    let ev;
    try {
      ev = JSON.parse(data);
    } catch (e) {
      return raw;
    }
    const name = /^event: ?(.*)$/m.exec(raw)?.[1] || ev.type;
    const emit = (obj) => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
    if (ev.type === 'content_block_start') {
      const cb = ev.content_block || {};
      // Tool calls to outbound tools are passed through as they are (null block: nothing restored).
      this.blocks.set(ev.index, cb.type === 'tool_use' && !restoresTool(cb.name, this.settings) ? null : { type: cb.type, pending: '' });
      return raw;
    }
    if (ev.type === 'content_block_delta') {
      const block = this.blocks.get(ev.index);
      const d = ev.delta || {};
      const field = d.type === 'text_delta' ? 'text' : d.type === 'input_json_delta' ? 'partial_json' : null;
      if (!block || !field || typeof d[field] !== 'string') return raw;
      const text = block.pending + d[field];
      const cut = PARTIAL_RE.exec(text);
      const ready = cut ? text.slice(0, cut.index) : text;
      block.pending = cut ? text.slice(cut.index) : '';
      if (!ready) return '';
      return emit({ ...ev, delta: { ...d, [field]: this.restore(ready, field) } });
    }
    if (ev.type === 'content_block_stop') {
      const block = this.blocks.get(ev.index);
      let out = '';
      if (block?.pending) {
        const field = block.type === 'tool_use' ? 'partial_json' : 'text';
        const type = field === 'text' ? 'text_delta' : 'input_json_delta';
        out = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: ev.index, delta: { type, [field]: this.restore(block.pending, field) } })}\n\n`;
      }
      this.blocks.delete(ev.index);
      return out + raw;
    }
    return raw;
  }

  restore(text, field) {
    return field === 'partial_json' ? restoreJsonString(text, this.vault) : R.restoreText(text, this.vault).text;
  }
}

module.exports = { redactRequest, restoreResponse, SseRestorer, literalRegex, restoresTool, restoreJsonString, PARTIAL_RE, NO_RESTORE };
