// Proxy mode for the OpenAI Chat Completions format (/v1/chat/completions), used by Hermes Agent, DeepSeek,
// OpenRouter and most agent frameworks. Same rules as the Messages API side (lib/proxy-transform.js):
//
//   requests   every message's text, tool-call arguments and tool results go through the rules, word lists and
//              memory, then a literal pass over the values already in the vault
//   responses  placeholders are restored in the text and in the arguments of tool calls that run on this machine;
//              calls to web, browser, messaging and MCP tools keep them (restoresTool)
//
// Tool-call arguments are JSON inside a string: requests parse them (so an escaped "Martínez" is still found),
// responses restore inside the string with JSON escaping.
'use strict';

const R = require('./redact.js');
const T = require('./proxy-transform.js');

// Arguments of a tool call: a JSON string. Mapped value by value when it parses, as text otherwise.
function mapArguments(args, fn) {
  if (typeof args !== 'string' || !args) return args;
  try {
    const value = JSON.parse(args);
    const mapped = R.mapStrings(value, fn);
    return mapped === value ? args : JSON.stringify(mapped);
  } catch (e) {
    return fn(args);
  }
}

function mapMessage(m, fn) {
  if (!m || typeof m !== 'object') return m;
  const out = { ...m };
  if (typeof m.content === 'string') out.content = fn(m.content);
  else if (Array.isArray(m.content)) {
    // Text parts only: images, audio and files are passed as they are.
    out.content = m.content.map((p) => (p && p.type === 'text' && typeof p.text === 'string' ? { ...p, text: fn(p.text) } : p));
  }
  if (typeof m.reasoning_content === 'string') out.reasoning_content = fn(m.reasoning_content);
  if (Array.isArray(m.tool_calls)) {
    out.tool_calls = m.tool_calls.map((tc) =>
      tc && tc.function ? { ...tc, function: { ...tc.function, arguments: mapArguments(tc.function.arguments, fn) } } : tc
    );
  }
  return out;
}

const mapChat = (body, fn) => (Array.isArray(body.messages) ? { ...body, messages: body.messages.map((m) => mapMessage(m, fn)) } : body);

// Returns { body, labels }, like redactRequest for the Messages API.
function redactChatRequest(body, settings, vault) {
  const labels = {};
  let out = mapChat(body, (s) => R.obfuscateText(s, settings, vault, labels).text);
  const re = T.literalRegex(vault);
  if (re) {
    const byValue = new Map(Object.entries(vault.data.tokens).map(([token, { value }]) => [value, token]));
    out = mapChat(out, (s) => (typeof s === 'string' && s ? s.replace(re, (v) => byValue.get(v) || v) : s));
  }
  return { body: out, labels };
}

// ---------- Responses ----------

const restoreText = (text, vault) => (typeof text === 'string' ? R.restoreText(text, vault).text : text);

function restoreChatResponse(json, vault, settings) {
  if (!json || !Array.isArray(json.choices)) return json;
  return {
    ...json,
    choices: json.choices.map((c) => {
      const msg = c && c.message;
      if (!msg) return c;
      const out = { ...msg, content: restoreText(msg.content, vault) };
      if (typeof msg.reasoning_content === 'string') out.reasoning_content = restoreText(msg.reasoning_content, vault);
      if (Array.isArray(msg.tool_calls)) {
        out.tool_calls = msg.tool_calls.map((tc) =>
          tc?.function && typeof tc.function.arguments === 'string' && T.restoresTool(tc.function.name, settings)
            ? { ...tc, function: { ...tc.function, arguments: T.restoreJsonString(tc.function.arguments, vault) } }
            : tc
        );
      }
      return { ...c, message: out };
    })
  };
}

// Streamed responses ("data: {chunk}" events, then "data: [DONE]"). Text that may be the start of a placeholder
// is held back until it is complete or the choice finishes.
class ChatSseRestorer {
  constructor(vault, settings) {
    this.vault = vault;
    this.settings = settings;
    this.buffer = '';
    this.pending = new Map(); // "choice:content" | "choice:reasoning" | "choice:tool:N" -> { text, json }
    this.tools = new Map(); // "choice:N" -> whether the call gets real values
    this.last = null; // envelope of the last chunk, for a final flush
  }

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
    return this.flushAll() + rest;
  }

  // Appends text to a held-back buffer; returns the part that is ready, restored.
  take(key, text, json) {
    const all = (this.pending.get(key)?.text || '') + text;
    const cut = T.PARTIAL_RE.exec(all);
    const ready = cut ? all.slice(0, cut.index) : all;
    if (cut) this.pending.set(key, { text: all.slice(cut.index), json });
    else this.pending.delete(key);
    return json ? T.restoreJsonString(ready, this.vault) : R.restoreText(ready, this.vault).text;
  }

  // Everything still held back for one choice, written into its delta.
  flushChoice(index, delta) {
    for (const [key, held] of [...this.pending]) {
      const [choice, kind, n] = key.split(':');
      if (Number(choice) !== index) continue;
      this.pending.delete(key);
      const text = held.json ? T.restoreJsonString(held.text, this.vault) : R.restoreText(held.text, this.vault).text;
      if (kind === 'content') delta.content = (delta.content || '') + text;
      else if (kind === 'reasoning') delta.reasoning_content = (delta.reasoning_content || '') + text;
      else {
        delta.tool_calls = delta.tool_calls ? [...delta.tool_calls] : [];
        const tc = delta.tool_calls.find((t) => t.index === Number(n));
        if (tc) tc.function = { ...tc.function, arguments: (tc.function?.arguments || '') + text };
        else delta.tool_calls.push({ index: Number(n), function: { arguments: text } });
      }
    }
    return delta;
  }

  flushAll() {
    if (!this.pending.size || !this.last) return '';
    const choices = [...new Set([...this.pending.keys()].map((k) => Number(k.split(':')[0])))].map((index) => ({
      index,
      delta: this.flushChoice(index, {}),
      finish_reason: null
    }));
    return `data: ${JSON.stringify({ ...this.last, choices })}\n\n`;
  }

  event(raw) {
    const m = /^data: ?(.*)$/m.exec(raw);
    if (!m) return raw;
    if (m[1].trim() === '[DONE]') return this.flushAll() + raw;
    let chunk;
    try {
      chunk = JSON.parse(m[1]);
    } catch (e) {
      return raw;
    }
    if (!Array.isArray(chunk.choices)) return raw;
    const { choices, ...envelope } = chunk;
    this.last = envelope;
    const out = choices.map((c) => {
      if (!c || !c.delta) return c;
      const delta = { ...c.delta };
      if (typeof delta.content === 'string') delta.content = this.take(`${c.index}:content`, delta.content, false);
      if (typeof delta.reasoning_content === 'string') delta.reasoning_content = this.take(`${c.index}:reasoning`, delta.reasoning_content, false);
      if (Array.isArray(delta.tool_calls)) {
        delta.tool_calls = delta.tool_calls.map((tc) => {
          const key = `${c.index}:${tc.index}`;
          if (tc.function?.name && !this.tools.has(key)) this.tools.set(key, T.restoresTool(tc.function.name, this.settings));
          if (!this.tools.get(key) || typeof tc.function?.arguments !== 'string') return tc;
          return { ...tc, function: { ...tc.function, arguments: this.take(`${c.index}:tool:${tc.index}`, tc.function.arguments, true) } };
        });
      }
      return { ...c, delta: c.finish_reason ? this.flushChoice(c.index, delta) : delta };
    });
    return `data: ${JSON.stringify({ ...envelope, choices: out })}\n\n`;
  }
}

module.exports = { redactChatRequest, restoreChatResponse, ChatSseRestorer, mapArguments };
