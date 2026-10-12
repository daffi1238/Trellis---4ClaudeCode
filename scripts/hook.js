#!/usr/bin/env node
// Entry point for every Trellis hook. Reads the hook's JSON from stdin and writes the decision to stdout.
//
//   UserPromptSubmit     block prompts with sensitive data (offering an obfuscated version); run /trellis:* commands
//   UserPromptExpansion  same commands, if they reach the expansion step
//   PreToolUse           restore placeholders for local tools; stop sensitive data going to outbound tools
//   PostToolUse          obfuscate tool results before Claude sees them
//   MessageDisplay       show the original values in Claude's replies, on screen only
//   SessionStart         explain placeholders to Claude; warn about sensitive data in CLAUDE.md
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const S = require('../lib/settings.js');
const Vault = require('../lib/vault.js');
const R = require('../lib/redact.js');
const Commands = require('../lib/commands.js');

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

  const settings = S.load('prompt');
  if (!settings.enabled || settings.prompt === 'off') return null;
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
  return block(reason + fileNote, eventName);
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

  if (LOCAL_TOOLS.has(tool) || localMcp) {
    if (!settings.restoreLocalTools) return null;
    const vault = Vault.read(projectDirOf(input));
    if (!vault.size) return null;
    const restored = R.restoreDeep(toolInput, vault);
    if (!restored.changed) return null;
    if (input.permission_mode === 'auto') return autoMode(tool, toolInput, vault, input, settings);
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
  const settings = S.load('tool');
  if (!settings.enabled || !settings.toolOutput) return null;
  if (input.tool_response === undefined || input.tool_response === null) return null;
  const result = Vault.update(projectDirOf(input), (vault) => R.obfuscateDeep(input.tool_response, settings, vault));
  if (!result.changed) return null;
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: result.value } };
}

// ---------- Display and session ----------

function onMessageDisplay(input) {
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
  const result = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: SESSION_CONTEXT } };
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
      result.systemMessage =
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
