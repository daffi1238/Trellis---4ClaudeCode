#!/usr/bin/env node
// Entry point for every Trellis hook. Reads the hook's JSON from stdin and writes the decision to stdout.
//
//   UserPromptSubmit     block prompts with sensitive data (offering an obfuscated version); run /trellis:* commands
//   UserPromptExpansion  same commands, if they reach the expansion step
//   PreToolUse           restore placeholders for local tools; stop sensitive data going to outbound tools
//   PostToolUse          obfuscate tool results before Claude sees them
//   MessageDisplay       show the original values in Claude's replies, on screen only
//   SessionStart         explain placeholders to Claude; warn about sensitive data in CLAUDE.md
//
// Behind the Trellis proxy (scripts/proxy.js), the proxy obfuscates and restores everything with its own vault, so
// the hooks only run the /trellis:* commands and ask before network-capable commands that hold sensitive values.
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const S = require('../lib/settings.js');
const Vault = require('../lib/vault.js');
const R = require('../lib/redact.js');
const Commands = require('../lib/commands.js');
const ProxyState = require('../lib/proxy-state.js');
const Service = require('../lib/service.js');
const ModPrompt = require('./mod-prompt.js');
const T = require('../lib/proxy-transform.js');

const LOCAL_TOOLS = new Set([
  'Bash', 'PowerShell', 'BashOutput', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'LS'
]);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const OUTBOUND_TOOLS = new Set(['WebFetch', 'WebSearch']);
// Trellis's own MCP server (scripts/mcp.js): local, restores placeholders itself.
const OWN_TOOL_RE = /^mcp__plugin_trellis_trellis__/;
const EDIT_TOOL = 'mcp__plugin_trellis_trellis__edit';
const MULTI_EDIT_TOOL = 'mcp__plugin_trellis_trellis__multi_edit';
const WRITE_TOOL = 'mcp__plugin_trellis_trellis__write';
const RUN_SCRIPT = path.join(__dirname, 'run.js');
// Commands that can send data off the machine (or run code that can).
const NETWORK_RE = new RegExp(
  '(?:^|[\\s;&|(`$\'"])(?:curl|wget|nc|ncat|netcat|socat|telnet|ssh|scp|sftp|rsync|ftp|http|https|xh|aria2c|' +
    'git\\s+(?:push|send-email|remote)|npm\\s+publish|yarn\\s+publish|pip\\s+upload|twine|aws|gcloud|gsutil|az|gh|' +
    'kubectl|docker|podman|mail|mailx|sendmail|python[0-9.]*|node|deno|bun|perl|ruby|php|' +
    'Invoke-WebRequest|Invoke-RestMethod|iwr|irm)(?=$|[\\s;&|)`\'"])|/dev/(?:tcp|udp)/|https?://',
  'i'
);

const PROXY_CONTEXT = [
  'Trellis (a privacy plugin) is active in this session, in proxy mode.',
  'Sensitive values (emails, keys, names, the user\'s own terms...) reach you as placeholders such as [EMAIL_1] or [NAME_2], wherever they come from.',
  'Use placeholders exactly as written, brackets included, in commands, file edits and replies: on the user\'s machine they become the real values before any tool runs, and the user sees the real values on screen.',
  'Do not guess, decode or reconstruct the original values, and do not ask the user for them.',
  'Use the built-in Edit and Write tools as usual: they work with placeholders here.',
  'Tools that send data off the machine (web fetch, web search, MCP servers) receive placeholders as they are.'
].join(' ');

const SESSION_CONTEXT = [
  'Trellis (a privacy plugin) is active in this session.',
  'Sensitive values in tool results (emails, keys, names, the user\'s own terms...) are replaced by placeholders such as [EMAIL_1] or [NAME_2].',
  'Use placeholders exactly as written, brackets included, in commands, file writes and replies: on the user\'s machine Trellis puts the real values back when local tools run, and the user sees the real values on screen.',
  `The built-in Edit tool cannot match text that contains placeholders (the file has the real values and Edit checks it before Trellis runs): when old_string would contain a placeholder, use the ${EDIT_TOOL} tool instead, with the same arguments (${MULTI_EDIT_TOOL} for several edits to one file). Write, NotebookEdit, Bash, Grep and Glob accept placeholders directly, except in auto mode, where Trellis tells you what to use instead (Bash, ${WRITE_TOOL}).`,
  'Do not guess, decode or reconstruct the original values, and do not ask the user for them.',
  'Tools that send data off the machine (web fetch, web search, MCP servers) receive placeholders as they are.',
  'Text such as EMAIL_1 without brackets is not a placeholder.'
].join(' ');

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

function projectDirOf(input) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

function block(reason, eventName) {
  return { decision: 'block', reason, hookSpecificOutput: { hookEventName: eventName, suppressOriginalPrompt: true } };
}

// ---------- Prompts ----------

// "@path" mentions: Claude Code attaches those files directly, without any tool call a hook could filter.
function mentionedFiles(prompt, cwd) {
  const files = [];
  const re = /(?:^|\s)@(?:"([^"]+)"|([^\s"]+))/g;
  let m;
  while ((m = re.exec(prompt)) !== null) {
    const raw = (m[1] || m[2]).replace(/#L?\d+(?:-\d+)?$/, '').replace(/[),.;:]+$/, '');
    if (!raw || raw.includes('://')) continue;
    const file = path.resolve(cwd, raw.replace(/^~(?=\/|$)/, os.homedir()));
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size <= 5 * 1024 * 1024) files.push({ raw, file });
    } catch (e) {
      // not a file (an agent, an MCP resource...)
    }
  }
  return files;
}

function onPrompt(input, eventName) {
  const prompt = String(input.prompt || '');
  const cmd = Commands.parse(prompt);
  if (cmd) return block(Commands.run(cmd, { cwd: input.cwd, projectDir: projectDirOf(input) }), eventName);
  // Behind the proxy, prompts and @ attachments are obfuscated on their way out: nothing to block.
  if (ProxyState.active()) return null;

  const settings = S.load('prompt');
  if (!settings.enabled || settings.prompt === 'off') return null;
  // The Trellis mod already rewrote this exact prompt (and redirects its @ attachments to obfuscated copies).
  if (settings.prompt === 'rewrite' && ModPrompt.wasHandled(input.session_id, prompt)) return null;
  const cwd = input.cwd || process.cwd();

  const fileFindings = [];
  for (const { raw, file } of mentionedFiles(prompt, cwd)) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue;
    }
    const labels = R.scan(text, settings);
    if (Object.keys(labels).length) fileFindings.push(`@${raw} contains ${R.describe(labels)}`);
  }

  const labels = R.scan(prompt, settings);
  const sensitive = Object.keys(labels).length > 0;
  if (!sensitive && !fileFindings.length) return null;

  const fileNote = fileFindings.length
    ? `\n\nFiles attached with @ are sent as they are, without Trellis: ${fileFindings.join('; ')}. ` +
      'Mention the path without @ and ask Claude to read it: its tools return the content obfuscated.'
    : '';

  if (settings.prompt === 'warn') {
    const what = sensitive ? `This prompt contained ${R.describe(labels)} and was sent as it was.` : '';
    return { systemMessage: `Trellis: ${what}${fileNote}`.trim() };
  }

  const modNote =
    settings.prompt === 'rewrite'
      ? '\n\n(With Claude Code 2.1.287 or later, Trellis rewrites prompts like this one by itself instead of blocking them.)'
      : '';
  let reason = '';
  if (sensitive) {
    const result = Vault.update(projectDirOf(input), (vault) => R.obfuscateText(prompt, settings, vault));
    reason =
      `Trellis blocked this prompt: it contains ${R.describe(labels)}. Nothing was sent.\n\n` +
      'Send this version instead (Claude only sees the placeholders; you see the real values in its replies):\n\n' +
      result.text;
  } else {
    reason = 'Trellis blocked this prompt. Nothing was sent.';
  }
  return block(reason + fileNote + modNote, eventName);
}

function onExpansion(input) {
  // Same commands when the CLI reports them by name ("trellis:add") rather than as typed text.
  const name = String(input.command_name || '').replace(/^\//, '');
  const m = /^trellis:(\w+)$/.exec(name);
  if (!m || !Commands.NAMES.includes(m[1])) return null;
  const cmd = { name: m[1], args: String(input.command_args || '').trim() };
  return block(Commands.run(cmd, { cwd: input.cwd, projectDir: projectDirOf(input) }), 'UserPromptExpansion');
}

// ---------- Tools ----------

function mcpServerOf(toolName, input) {
  if (input.mcp_server) return String(input.mcp_server);
  const m = /^mcp__(.+?)__/.exec(toolName);
  return m ? m[1] : null;
}

function onPreToolUse(input) {
  const settings = S.load('tool');
  if (!settings.enabled) return null;
  const tool = String(input.tool_name || '');
  if (OWN_TOOL_RE.test(tool)) return null;
  const toolInput = input.tool_input;
  const server = mcpServerOf(tool, input);
  const localMcp = server && (settings.localMcpServers || []).includes(server);
  const proxy = ProxyState.active();
  // Behind the proxy, local tools already get the real values; outbound tools are still checked below.
  if (proxy && (LOCAL_TOOLS.has(tool) || localMcp)) return proxyPreToolUse(tool, toolInput, settings);

  if (LOCAL_TOOLS.has(tool) || localMcp) {
    // An @ attachment read from an obfuscated copy: tools aimed at the copy go to the original file.
    const redirected = R.mapStrings(toolInput, ModPrompt.toOriginals);
    if (!settings.restoreLocalTools) return redirected === toolInput ? null : { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: redirected } };
    const vault = Vault.read(projectDirOf(input));
    const restored = vault.size ? R.restoreDeep(redirected, vault) : { value: redirected, tokens: new Set(), changed: false };
    restored.changed = restored.value !== toolInput;
    if (!restored.changed) return null;
    if (input.permission_mode === 'auto') return autoMode(tool, redirected, vault, input, settings);
    const hso = { hookEventName: 'PreToolUse', updatedInput: restored.value };
    if (SHELL_TOOLS.has(tool) && settings.networkCommands !== 'allow' && NETWORK_RE.test(String(toolInput.command || ''))) {
      hso.permissionDecision = 'ask';
      hso.permissionDecisionReason =
        `Trellis: this command will run with the real values of ${[...restored.tokens].join(', ')} and may send them over the network. Allow only if that is intended.`;
    }
    return { hookSpecificOutput: hso };
  }

  if (OUTBOUND_TOOLS.has(tool) || server) {
    if (settings.outbound === 'allow') return null;
    const labels = R.scanDeep(toolInput, settings);
    if (!Object.keys(labels).length) return null;
    const reason =
      `Trellis: the input of ${tool} contains sensitive data (${R.describe(labels)}) and this tool sends it off the machine. ` +
      'Use placeholders instead, or ask the user to allow it.';
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: settings.outbound === 'ask' ? 'ask' : 'deny', permissionDecisionReason: reason } };
  }
  return null;
}

// Behind the proxy, tool inputs already hold the real values. Only shell commands that hold sensitive values and
// look able to reach the network are checked, by the rules and by the values the proxy has seen.
function proxyPreToolUse(tool, toolInput, settings) {
  if (!SHELL_TOOLS.has(tool) || settings.networkCommands === 'allow') return null;
  const command = String(toolInput?.command || '');
  if (!NETWORK_RE.test(command)) return null;
  const labels = R.scan(command, settings);
  const vault = Vault.readFile(ProxyState.vaultFile());
  const re = T.literalRegex(vault);
  if (re) {
    const byValue = new Map(Object.values(vault.data.tokens).map((t) => [t.value, t.label]));
    for (const v of command.match(re) || []) labels[byValue.get(v)] = (labels[byValue.get(v)] || 0) + 1;
  }
  if (!Object.keys(labels).length) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: `Trellis: this command contains sensitive data (${R.describe(labels)}) and may send it over the network. Allow only if that is intended.`
    }
  };
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// In auto mode, Claude Code sends each pending tool call, after the hooks, to a classifier model: an input with
// restored values would reach the model provider. So no real value is ever put into a tool input here. Shell
// commands are wrapped (scripts/run.js restores them when they run); Trellis's own MCP tools restore inside the
// server; everything else is denied with a pointer to one of those.
function autoMode(tool, toolInput, vault, input, settings) {
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  if (tool === 'Bash') {
    // Placeholders only in other fields (the description) need nothing.
    if (!R.restoreText(command, vault).tokens.size) return null;
    const tag = `TRELLIS_${crypto.randomBytes(6).toString('hex')}`;
    const wrapped = `node ${quote(RUN_SCRIPT)} ${quote(Vault.vaultPath(projectDirOf(input)))} <<'${tag}'\n${command}\n${tag}`;
    const hso = { hookEventName: 'PreToolUse', updatedInput: { ...toolInput, command: wrapped } };
    if (settings.networkCommands !== 'allow' && NETWORK_RE.test(command)) {
      hso.permissionDecision = 'ask';
      hso.permissionDecisionReason = 'Trellis: this command will run with real values in place of its placeholders and may send them over the network. Allow only if that is intended.';
    }
    return { hookSpecificOutput: hso };
  }
  const instead =
    tool === 'Write'
      ? `use the ${WRITE_TOOL} tool with the same arguments`
      : 'use the Bash tool (for example cat, grep, find, or a short script) with the placeholders in the command';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Trellis: in auto mode, ${tool} cannot receive the real values behind placeholders (the auto-mode classifier would see them). ` +
        `Instead, ${instead}: Trellis restores the values there without exposing them.`
    }
  };
}

function onPostToolUse(input) {
  if (ProxyState.active()) return null; // the proxy obfuscates tool results on their way out
  const settings = S.load('tool');
  if (!settings.enabled || !settings.toolOutput) return null;
  if (input.tool_response === undefined || input.tool_response === null) return null;
  const result = Vault.update(projectDirOf(input), (vault) => R.obfuscateDeep(input.tool_response, settings, vault));
  if (!result.changed) return null;
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: result.value } };
}

// ---------- Display and session ----------

function onMessageDisplay(input) {
  if (ProxyState.active()) return null; // replies already arrive with the real values
  const settings = S.load('prompt');
  if (!settings.enabled || !settings.restoreDisplay) return null;
  const text = input.delta;
  if (typeof text !== 'string' || !text.includes('[')) return null;
  const vault = Vault.read(projectDirOf(input));
  if (!vault.size) return null;
  const restored = R.restoreText(text, vault);
  if (!restored.tokens.size) return null;
  return { hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent: restored.text } };
}

// After restarting the proxy service, give it a moment to publish its state again.
function waitBriefly() {
  for (let i = 0; i < 20 && !ProxyState.active(); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}

function claudeMdFiles(projectDir) {
  return [
    path.join(projectDir, 'CLAUDE.md'),
    path.join(projectDir, 'CLAUDE.local.md'),
    path.join(projectDir, '.claude', 'CLAUDE.md'),
    path.join(os.homedir(), '.claude', 'CLAUDE.md')
  ];
}

function onSessionStart(input) {
  const settings = S.load('prompt');
  if (!settings.enabled) return null;
  // Vaults written by versions before encryption are encrypted now, not at their next new placeholder.
  for (const file of [Vault.vaultPath(projectDirOf(input)), ProxyState.vaultFile()]) Vault.encryptInPlace(file);
  let updated = null;
  try {
    updated = Service.refresh(); // after a plugin update, the proxy service runs the new version
  } catch (e) {
    updated = `Trellis: could not update the proxy service (${e.message}).`;
  }
  const proxy = updated ? (waitBriefly(), ProxyState.active()) : ProxyState.active();
  if (proxy) {
    return {
      systemMessage: [updated, `Trellis: proxy mode (${proxy.url}). Everything sent to the model is obfuscated, CLAUDE.md and @ attachments included.`].filter(Boolean).join('\n'),
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: PROXY_CONTEXT }
    };
  }
  const result = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: SESSION_CONTEXT } };
  if (updated) result.systemMessage = updated;
  if (settings.checkClaudeMd) {
    const findings = [];
    for (const file of claudeMdFiles(projectDirOf(input))) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (e) {
        continue;
      }
      const labels = R.scan(text, settings);
      if (Object.keys(labels).length) findings.push(`${file.replace(os.homedir(), '~')} (${R.describe(labels)})`);
    }
    if (findings.length) {
      result.systemMessage = (updated ? updated + '\n' : '') +
        `Trellis: these files are sent to Claude as they are, at the start of every session, and contain sensitive data: ${findings.join('; ')}. ` +
        'Move that data out of them, or replace it with placeholders.';
    }
  }
  return result;
}

const HANDLERS = {
  UserPromptSubmit: (i) => onPrompt(i, 'UserPromptSubmit'),
  UserPromptExpansion: onExpansion,
  PreToolUse: onPreToolUse,
  PostToolUse: onPostToolUse,
  MessageDisplay: onMessageDisplay,
  SessionStart: onSessionStart
};

function handle(input) {
  const handler = HANDLERS[input && input.hook_event_name];
  return handler ? handler(input) : null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch (e) {
    process.stderr.write('Trellis: invalid hook input\n');
    return;
  }
  if (input.hook_event_name === 'SessionStart' || input.hook_event_name === 'UserPromptSubmit') {
    try {
      S.writePointer(); // lets the mod's helper find this data directory
    } catch (e) {
      process.stderr.write(`Trellis: ${e.message}\n`);
    }
  }
  try {
    const result = handle(input);
    if (result) out(result);
  } catch (e) {
    // Fail closed where a failure would let data through unchecked.
    const msg = `Trellis failed (${e.message}).`;
    const event = input.hook_event_name;
    if (event === 'UserPromptSubmit') out(block(`${msg} The prompt was not sent; try again.`, event));
    else if (event === 'PostToolUse' && input.tool_response != null) {
      // Same shape as the real output (otherwise Claude Code would use the original), every string withheld.
      const withheld = typeof input.tool_response === 'string' ? `[${msg} Output withheld.]` : R.mapStrings(input.tool_response, () => '[withheld by Trellis]');
      out({ hookSpecificOutput: { hookEventName: event, updatedToolOutput: withheld } });
    } else process.stderr.write(msg + '\n');
  }
}

if (require.main === module) main();

module.exports = { handle, NETWORK_RE, mentionedFiles };
