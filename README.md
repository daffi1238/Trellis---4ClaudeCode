# Trellis for Claude Code

**Keep sensitive data out.**

A [Claude Code](https://code.claude.com) plugin that keeps personal and confidential data out of the conversation.
It is the Claude Code version of the [Trellis browser extension](https://github.com/daffi1238/Trellis), with the
same rules, memory and word lists.

- **What Claude reads is obfuscated.** File contents, command output, search results and MCP results reach Claude
  with placeholders: `laura.martinez@example.com` becomes `[EMAIL_1]`.
- **The real values stay on your machine and keep working.** When Claude edits a file or runs a command with
  `[EMAIL_1]`, Trellis puts the real value back before the tool runs. In Claude's replies, you see the real values
  on your screen.
- **Sensitive prompts are never sent.** A prompt with sensitive data is blocked, and Trellis gives you an
  obfuscated version ready to send.
- **Your own terms.** Add people, companies, clients or projects to the memory with `/trellis:add`. The command
  runs on your machine, so the terms themselves are never sent either.

Everything runs locally in Node.js. Trellis makes no network requests and has no dependencies.

> **Status: early version (0.1.0).** Tested end to end with Claude Code 2.1.296 (`claude -p`): Claude only saw
> placeholders when reading files, and no message sent to the model held an original value; edits (Trellis's
> `edit` and `multi_edit`, `NotebookEdit`) and `grep` worked on the real values; `curl` with a real value was
> stopped; sensitive prompts, `@` attachments and `/trellis:*` commands were blocked before any API call.
> Feedback and issues are welcome.

## Install

Requires Node.js 18 or later.

```
/plugin marketplace add daffi1238/Trellis-4ClaudeCode
/plugin install trellis@trellis
```

Restart Claude Code, then check `/trellis:status`.

## How it works

Trellis is a set of [hooks](https://code.claude.com/docs/en/hooks):

| Hook | What Trellis does |
|---|---|
| `SessionStart` | Tells Claude that `[LABEL_N]` are placeholders to use as they are. Warns you if a `CLAUDE.md` contains sensitive data. |
| `UserPromptSubmit` | Blocks prompts with sensitive data and offers an obfuscated version. Checks files attached with `@`. Runs the `/trellis:*` commands. |
| `PostToolUse` | Obfuscates every tool result before Claude sees it, keeping its structure. |
| `PreToolUse` | Local tools (`Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`...) get placeholders replaced by the real values. Tools that send data off the machine (`WebFetch`, `WebSearch`, MCP servers) never do, and are denied input with sensitive data. |
| `MessageDisplay` | Shows the real values in Claude's replies, on your screen only. The conversation keeps the placeholders. |

It also includes a local MCP server with two tools, `edit` and `multi_edit` (several edits to one file, all or
nothing). Claude Code checks that an `Edit`'s `old_string` exists in the file before any hook runs, so an `Edit`
with `[EMAIL_1]` in it always fails (the file has the real value). Claude is told to use Trellis's tools for those
edits instead: they put the real values back and apply the change on your machine. The first time, Claude Code asks
you to allow them, like any MCP tool. `Write` and `NotebookEdit` do not have this problem (they do not check the new
content against the file), so the hook restores their placeholders directly.

### An example

```
you    > Find who owns the staging database in config/team.yml
Claude > Read config/team.yml
         owner: [NAME_1] [SURNAME_1] <[EMAIL_1]>      ← what Claude sees
Claude > The owner is Laura Martínez (laura.martinez@example.com).   ← what you see
you    > Add a comment with her email above the db block
Claude > trellis edit config/team.yml: "# contact: [EMAIL_1]"
         → the file gets "# contact: laura.martinez@example.com"
```

### Placeholders

- One placeholder per exact value: `laura@example.com` and `LAURA@EXAMPLE.COM` get different placeholders, so
  edits restore exactly what was in the file.
- Placeholders are kept per project, in `vault/<hash>.json` inside the data directory (readable only by you), so
  they survive resumed and compacted sessions. `/trellis:clear` forgets them.
- Only the bracketed form is restored: `EMAIL_1` in code is left alone.

### Commands that could send data out

A shell command that receives real values and looks able to reach the network (`curl`, `ssh`, `git push`,
`python`, `node`...) asks for your permission first, showing which placeholders it would receive. This protects you from a prompt injection in a file trying to send your data somewhere. In non-interactive
runs (`claude -p`) there is nobody to ask, so the command is denied.

## Commands

The commands run on your machine and never reach Claude; their replies do not repeat your terms.

| Command | |
|---|---|
| `/trellis:add <term>[, <term>...] [--as <Category>] [--partial]` | Hide terms everywhere. `--partial` also matches inside other words (`hooli` in `HooliDC`). |
| `/trellis:allow <term>[, ...]` | Never obfuscate these values (false positives). Memory still wins. |
| `/trellis:forget <term>[, ...]` | Remove terms from the memory and the allowlist. |
| `/trellis:scan <file>` | Show what Trellis would hide in a file. |
| `/trellis:import <file>` | Import a settings file exported from the Trellis browser extension, or a memory list. |
| `/trellis:clear` | Forget this project's placeholders. |
| `/trellis:status` | Settings and counts. |
| `/trellis:help` | The list of commands. |

## What is detected

The same as the browser extension:

- **Rules:** emails, API keys (Anthropic, OpenAI, AWS, GitHub, Slack, Google), JWTs, private keys, passwords and
  tokens in assignments (`password=...`), IBANs, card numbers, IPv4 addresses, Spanish national IDs and phone
  numbers. Add your own regex or keyword rules.
- **Word lists:** first names and surnames in many languages (capitalized words only), with a list of exceptions.
- **Memory:** your own terms, matched ignoring case and accents.

## Settings

Settings are stored in `settings.json` in the plugin's data directory (`~/.claude/plugins/data/<plugin id>/`; set
`TRELLIS_HOME` to use another directory). `/trellis:status` shows the exact path. Only the keys you change need to
be there:

```json
{
  "prompt": "block",
  "toolOutput": true,
  "wordlistsInToolOutput": true,
  "restoreLocalTools": true,
  "networkCommands": "ask",
  "outbound": "deny",
  "localMcpServers": [],
  "restoreDisplay": true,
  "checkClaudeMd": true,
  "rules": [],
  "memory": [{ "term": "Northwind Traders", "category": "Company" }],
  "allowlist": [],
  "exceptionsExtra": ""
}
```

| Key | Values | Default |
|---|---|---|
| `enabled` | Turn Trellis off without uninstalling it | `true` |
| `prompt` | `block`, `warn` (send and notify), `off` | `block` |
| `toolOutput` | Obfuscate tool results | `true` |
| `wordlistsInToolOutput` | Apply the name lists to tool results too. Turn off if they add noise in code; memory and rules still apply | `true` |
| `restoreLocalTools` | Put real values back for local tools | `true` |
| `networkCommands` | `ask` or `allow` for network-capable commands that receive real values | `ask` |
| `outbound` | `deny`, `ask` or `allow` for web and MCP tools whose input contains sensitive data | `deny` |
| `localMcpServers` | MCP servers that run locally and may receive real values, e.g. `["sqlite"]` | `[]` |
| `restoreDisplay` | Show real values in replies on your screen | `true` |
| `checkClaudeMd` | Warn about sensitive data in `CLAUDE.md` files at session start | `true` |
| `rules`, `memory`, `allowlist`, `exceptionsExtra`, `wordlists` | Same format as the browser extension | |

## Limitations

Trellis only sees what passes through hooks. Know what it does not cover:

- **Files attached with `@`** are added by Claude Code without a tool call. Trellis checks them and blocks the
  prompt if they contain sensitive data, but cannot obfuscate them: mention the path without `@` and let Claude
  read it.
- **`CLAUDE.md` and other context loaded automatically** (memory files, the git status Claude Code adds to the
  system prompt) are sent as they are. Trellis warns about `CLAUDE.md` files, but cannot change them.
- **The built-in `Edit` tool cannot use placeholders** (see above); those edits go through Trellis's `edit` and
  `multi_edit` tools.
- **Prompts cannot be rewritten** by a hook, only blocked; that is why you get an obfuscated version to send.
- **Tool errors** cannot be rewritten by hooks: an error message that quotes sensitive data reaches Claude.
- **Images and PDFs** are not inspected.
- **Detection is pattern based.** It will miss data that matches no rule, list or memory term, and can hide words
  that are not sensitive (use `/trellis:allow`). The name lists can obfuscate capitalized identifiers in code
  (`wordlistsInToolOutput: false` turns them off for tool results).
- **Local files and commands get real values.** That is the point, but it means a script Claude writes can still
  use them. Network-capable commands ask first; other ways out (a test that sends email, a build that uploads)
  cannot be detected.
- **Literal placeholders.** Text that already looks like a known placeholder (`[EMAIL_1]`) is restored when Claude
  writes it to a file.
- **Local transcripts** (`~/.claude/projects/`) and your terminal history may contain original values (the prompts
  you typed, and the log of what the hooks returned); they stay on your machine and are not sent to Claude.

## Development

```bash
npm test                         # unit tests: feed hook JSON to scripts/hook.js on stdin
claude plugin validate .         # check the manifests
claude --plugin-dir .            # try it without installing
```

The detection engine is shared with the [browser extension](https://github.com/daffi1238/Trellis): `lib/obfuscator.js`,
`wordlists/` and `lib/default-rules.json` are copied from it, never edited here. Change them in Trellis, then:

```bash
npm run sync-engine -- --from ../Trellis     # copy the engine, word lists and default rules
npm run check-engine -- --from ../Trellis    # only compare (exit 1 if they differ)
```

CI runs the check against Trellis's `main` on every push and every Monday, so a change to the engine in Trellis
shows up here as a failing check until it is synced.

## License

MIT
