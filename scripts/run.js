#!/usr/bin/env node
// Runs a shell command with Trellis placeholders replaced by their real values, at execution time.
//
// In auto mode, Claude Code sends every pending tool call, as the PreToolUse hooks left it, to a classifier model.
// Restoring placeholders in the hook would hand that model the real values, so the hook wraps the command instead:
//
//   node run.js <vault file> <<'TRELLIS_<random>'
//   <the command, with placeholders>
//   TRELLIS_<random>
//
// The classifier sees the command with placeholders; the real values only exist in this process and its child.
// The command runs in its own bash, so a `cd` inside it does not carry over to later commands.
'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const Vault = require('../lib/vault.js');
const R = require('../lib/redact.js');

const vaultFile = process.argv[2];
if (!vaultFile) {
  process.stderr.write('usage: run.js <vault file>  (command on stdin)\n');
  process.exit(2);
}
// The heredoc ends with a newline that is not part of the command.
const command = fs.readFileSync(0, 'utf8').replace(/\n$/, '');
const vault = Vault.readFile(vaultFile);
const { text } = R.restoreText(command, vault);
const r = spawnSync('/bin/bash', ['-c', text], { stdio: ['ignore', 'inherit', 'inherit'] });
if (r.error) {
  process.stderr.write(`trellis: ${r.error.message}\n`);
  process.exit(127);
}
process.exit(r.status ?? (r.signal ? 128 + (require('node:os').constants.signals[r.signal] || 0) : 1));
