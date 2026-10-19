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
- **Prompts are sent with placeholders.** You type `laura.martinez@example.com`, Claude receives `[EMAIL_1]`, and
  files you attach with `@` are read from an obfuscated copy (Claude Code 2.1.287 or later, through a
  [mod](https://code.claude.com/docs/en/plugins/mods/overview)). On earlier versions a prompt with sensitive data is
  blocked, and Trellis gives you an obfuscated version ready to send.
- **Your own terms.** Add people, companies, clients or projects to the memory with `/trellis:add`. The command
  runs on your machine, so the terms themselves are never sent either.

Everything runs locally in Node.js. Trellis makes no network requests and has no dependencies.

> **Status: early version (0.7.0).** Tested end to end with Claude Code 2.1.296 (`claude -p`): Claude only saw
> placeholders when reading files, and no message sent to the model held an original value; edits (Trellis's
> `edit` and `multi_edit`, `NotebookEdit`) and `grep` worked on the real values; `curl` with a real value was
> stopped; sensitive prompts, `@` attachments and `/trellis:*` commands were blocked before any API call; in auto
> mode, recorded API requests (including the classifier's) held no original values.
> Feedback and issues are welcome.

## Install

Requires Node.js 18 or later. Hooks run in Claude Code on your machine, so Trellis works the same with any model
provider Claude Code is pointed at (Anthropic, or another one through `ANTHROPIC_BASE_URL`).

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
| `UserPromptSubmit` | Runs the `/trellis:*` commands. Blocks prompts with sensitive data that the mod did not rewrite (Claude Code before 2.1.287, or the mod failed), offering an obfuscated version, and checks files attached with `@`. |
| `PostToolUse` | Obfuscates every tool result before Claude sees it, keeping its structure. |
| `PreToolUse` | Local tools (`Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`...) get placeholders replaced by the real values. Tools that send data off the machine (`WebFetch`, `WebSearch`, MCP servers) never do, and are denied input with sensitive data. |
| `MessageDisplay` | Shows the real values in Claude's replies, on your screen only. The conversation keeps the placeholders. |

### The prompt mod

On Claude Code 2.1.287 or later, the plugin's [mod](https://code.claude.com/docs/en/plugins/mods/overview)
(`hooks/prompt-mod.js`) handles two events before anything is sent:

- **`prompt.submit`:** the prompt is rewritten with placeholders, with the same engine, memory and vault as the
  hooks. `@` mentions of files are left as typed so they still resolve. A dim line in the transcript says what was
  replaced; Claude never reads it.
- **`prompt.mention`** (2.1.290 or later): a file attached with `@` that holds sensitive data is read from an
  obfuscated copy in the data directory, and Claude is told the original path; tools aimed at the copy are sent to
  the original. Binary files (images, PDFs) are attached as they are.

Mods have no Node.js APIs, so the mod runs `scripts/mod-prompt.js` for the work. It fails safe: if that script
cannot run, the prompt goes on unchanged and the `UserPromptSubmit` hook blocks it as on earlier versions, and an
attachment that cannot be checked is not attached. The hook recognises a prompt the mod rewrote by a hash the script
leaves for that session, so nothing is blocked twice.

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
- Placeholders are kept per project, in `vault/<hash>.json` inside the data directory, so they survive resumed and
  compacted sessions. `/trellis:clear` forgets them.

### Vault encryption

The vaults hold the original values, so they are encrypted (AES-256-GCM) with a key kept apart from them:

1. `TRELLIS_VAULT_KEY` (32 bytes, base64), when set: for automation.
2. The system keyring: macOS Keychain, or the Secret Service on Linux (GNOME Keyring, KWallet…) through
   `secret-tool` (`sudo apt install libsecret-tools` on Debian/Ubuntu).
3. Otherwise a key file, `~/.config/trellis/vault-key.json` (readable only by you), outside the data directory, so a
   backup or sync of `~/.claude` does not carry the vaults and their key together.

`/trellis:status` shows which one is used; `~/.config/trellis/vault-key.json` records it, so a locked keyring never
leads to a new key. If the key cannot be read, Trellis fails closed (tool results withheld, prompts blocked) until
it can. A vault the key cannot open (key lost) is moved aside (`*.unreadable-*`) and a new one started. Vaults from
earlier versions are encrypted at the next session start.

This protects the values at rest: backups, synced or shared folders, a vault copied by mistake. It does not protect
them from programs running as you, which can read the key file or ask the keyring as Trellis does. Your settings
(`settings.json`, including the memory terms) stay in plain JSON, so you can edit them.
- Only the bracketed form is restored: `EMAIL_1` in code is left alone.

### Auto mode

In auto mode, Claude Code sends every pending tool call to a classifier model (with your model provider) to decide
whether to allow it, *after* the hooks have run. If Trellis put the real values into tool inputs there, the
classifier would receive them. So in auto mode Trellis never does:

- **Bash:** the command is wrapped in a small launcher (`scripts/run.js`) that replaces the placeholders when it
  runs. The classifier sees the command with placeholders and can still judge it.
- **Write:** denied with a pointer to Trellis's `write` tool, which restores the values inside its local server.
  `edit` and `multi_edit` already work that way.
- **Read, Grep, Glob, NotebookEdit and local MCP servers** with placeholders in their input are denied with a pointer
  to Bash.

This was found and fixed by recording the API requests of a live auto-mode session: before the fix, the classifier
request held the real value; after it, no request did.

### Commands that could send data out

A shell command that receives real values and looks able to reach the network (`curl`, `ssh`, `git push`,
`python`, `node`...) asks for your permission first, showing which placeholders it would receive. This protects you from a prompt injection in a file trying to send your data somewhere. In non-interactive
runs (`claude -p`) there is nobody to ask, so the command is denied.

## Proxy mode (experimental)

Hooks only see what passes through them. Proxy mode closes the remaining gaps: a local proxy between Claude Code and
the model API obfuscates every Messages API request on its way out, whatever put the data there (`CLAUDE.md`, `@`
attachments, the git status, tool errors, Claude Code's own internal calls such as the auto-mode classifier), and
restores the responses on their way back.

Run `/trellis:proxy` in Claude Code: it prints the exact command to start the proxy with the plugin's settings and
memory. It looks like this:

```bash
TRELLIS_HOME=~/.claude/plugins/data/<plugin id> node <plugin dir>/scripts/proxy.js   # 127.0.0.1:8788 -> api.anthropic.com
ANTHROPIC_BASE_URL=http://127.0.0.1:8788 claude
```

`--upstream <url>` forwards to another Anthropic-compatible API. The proxy keeps one vault for every session
(`vault/proxy.json`).

### Other agents (OpenAI-compatible: Hermes Agent, DeepSeek, OpenRouter…)

The proxy also speaks OpenAI's Chat Completions format (`/v1/chat/completions`), so any agent that lets you set a
custom OpenAI-compatible endpoint can use it. For example, Hermes Agent against DeepSeek:

```bash
node scripts/proxy.js --upstream https://api.deepseek.com     # or https://openrouter.ai/api/v1, ...
```

Then, in Hermes, add a custom OpenAI-compatible provider (`hermes model`, or the custom provider in `config.yaml`)
with base URL `http://127.0.0.1:8788/v1`, your DeepSeek API key and the model (`deepseek-chat`).

The API key is passed through to the upstream; the proxy never stores it. The same obfuscation applies: messages,
text parts, tool results (command output, HTTP traffic with `Cookie`/`Set-Cookie` headers, logs) and tool-call
arguments, parsed as JSON so escaped text is caught too. Replies are restored, streamed or not, including DeepSeek's
`reasoning_content`.

Which tool calls get the real values back decides what can leave your machine:

- By default every tool does, except web, browser, messaging and MCP tools: `WebFetch`, `WebSearch`, `mcp__*`,
  `web_*`, `browser_*`, `send_*`, `email_*`, `http_*`, `fetch_*`, `*_search`, `*_fetch`.
- `"proxyNoRestoreTools": ["deploy_*"]` adds patterns to that list.
- `"proxyRestoreTools": ["terminal", "read_file"]` turns it around: only those tools get real values.

A tool that receives real values can still send them somewhere: limit where the agent's machine can connect (a
firewall, an egress proxy such as iron-proxy, Claude Code's sandbox) when it handles sensitive data. User names in
assignments (`user=`, `login:`) are detected by the `user-assign` rule, off by default because it is noisy in code:
turn it on in `settings.json` for logs and traffic.

### As a service (Linux)

```
/trellis:proxy install [--port 8788] [--upstream https://api.anthropic.com]
```

creates a systemd user service (`~/.config/systemd/user/trellis-proxy.service`) that starts with your session and is
restarted if it stops. It runs a copy of the proxy kept in the data directory, because the plugin's own directory
changes with every update; when the plugin updates, the next session start refreshes that copy and restarts the
service. Then point Claude Code to it, in your shell profile (`export ANTHROPIC_BASE_URL=http://127.0.0.1:8788`) or
in `~/.claude/settings.json` (`"env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8788" }`).

`/trellis:proxy` shows whether the session uses it and the service's state; `/trellis:proxy uninstall` stops and
removes it (then remove `ANTHROPIC_BASE_URL`, or Claude Code cannot reach the model). Logs:
`journalctl --user -u trellis-proxy`. The service uses the `node` that ran the install; reinstall if you remove that
Node.js version. To keep it running without an open session: `loginctl enable-linger`.

**With the plugin installed**, sessions started with `ANTHROPIC_BASE_URL` pointing to the running proxy are detected,
and the plugin steps aside: it no longer blocks prompts, obfuscates tool results or restores anything (a second vault
would number placeholders differently), and Trellis's `edit` tools are not offered (the built-in ones get the real
values). It still runs the `/trellis:*` commands, asks before network-capable shell commands that contain sensitive
values, and denies web and MCP tools sensitive input. If the proxy stops, Claude Code cannot reach the model at all,
so nothing goes out unobfuscated.

| | Hooks (plugin) | Proxy mode |
|---|---|---|
| Tool results, prompts | ✅ | ✅ |
| `@` attachments | ✅ obfuscated copy with the mod (blocked before 2.1.290) | ✅ obfuscated |
| `CLAUDE.md`, git status, tool errors | ⚠️ warns about `CLAUDE.md` | ✅ obfuscated |
| Auto-mode classifier | ✅ (Bash wrapped, other tools redirected) | ✅ |
| Sensitive prompts | sent obfuscated by the mod (blocked before Claude Code 2.1.287) | sent obfuscated |
| Built-in `Edit` with placeholders | ❌ (Trellis's `edit` tool instead) | ✅ (Claude Code gets real values) |
| Web and MCP tools get placeholders, never real values | ✅ | ✅ |
| Network-capable commands with real values ask first | ✅ | ✅ with the plugin installed |
| Setup | `/plugin install` | a process to keep running, and `ANTHROPIC_BASE_URL` |

The recommended setup is both: the plugin, and proxy mode when you can keep the proxy running.

How it works:

- **Requests:** every string in `system` and `messages` goes through the rules, word lists and memory, then through a
  literal pass that replaces every value already in the vault, wherever it appears (responses are restored, so
  Claude Code sends real values back in the history, sometimes where no rule would detect them again).
- **Responses:** placeholders are restored in text and in tool calls, including streamed responses, where a
  placeholder can be split across chunks. Tool calls to web and MCP tools are left with placeholders.
- **Thinking blocks** are never changed: the API rejects a modified one. The model only sees placeholders, so they
  only contain placeholders.
- **Deterministic:** the same history always gives the same request, so prompt caching keeps working.
- **Fails closed:** a request that cannot be obfuscated is not sent.

Tested live with Claude Code 2.1.296, with and without the plugin, with the API requests recorded behind the proxy:
the built-in `Edit` and Bash worked on the real values, the `CLAUDE.md` and `@` attachment data were obfuscated, a
`curl` with a real email asked first, and no request held an original value. Obfuscation costs about 60 ms for a 400 KB request.

Limits: only requests to the model API go through the proxy. Web fetches, MCP servers, telemetry and claude.ai
connectors use their own connections (tool calls to them keep placeholders, see above). Local transcripts hold the
real values.

## Commands

The commands run on your machine and never reach Claude; their replies do not repeat your terms.

| Command | |
|---|---|
| `/trellis:add <term>[, <term>...] [--as <Category>] [--partial]` | Hide terms everywhere. `--partial` also matches inside other words (`hooli` in `HooliDC`). |
| `/trellis:allow <term>[, ...]` | Never obfuscate these values (false positives). Memory still wins. |
| `/trellis:forget <term>[, ...]` | Remove terms from the memory and the allowlist. |
| `/trellis:scan <file>` | Show what Trellis would hide in a file. |
| `/trellis:import <file>` | Import a settings file exported from the Trellis browser extension, or a memory list. |
| `/trellis:clear` | Forget this project's placeholders (all of the proxy's, in proxy mode). |
| `/trellis:proxy` | How to start proxy mode, or whether this session uses it. |
| `/trellis:proxy install [--port N] [--upstream URL]` | Run the proxy as a systemd user service (Linux). |
| `/trellis:proxy uninstall` | Remove that service. |
| `/trellis:status` | Settings and counts. |
| `/trellis:help` | The list of commands. |

## What is detected

The same as the browser extension:

- **Rules:** emails, phone numbers (Spanish and international), IBANs, cards, Spanish IDs, IPv4 addresses, JWTs,
  private keys, `password=`-style secrets, passwords in URLs (`postgres://user:password@host`), `Authorization`
  headers, webhook URLs (Slack, Discord, Teams) and API keys of about 50 providers (Anthropic, OpenAI, AWS, Google,
  GitHub, GitLab, Slack, Stripe, Twilio, SendGrid, npm, PyPI, Hugging Face, DigitalOcean, Vault…). Cards, IBANs,
  Spanish IDs and JWTs must pass their checksum or structure check (Luhn, ISO 13616 mod-97, DNI/NIE letter, JWT
  header), so an order number is not taken for a card. API key formats are adapted from
  [gitleaks](https://github.com/gitleaks/gitleaks) (MIT, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). Add
  your own regex or keyword rules; new built-in rules reach your settings on update, except those you deleted
  (`dismissedRules`).
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
| `prompt` | `rewrite` (sent with placeholders by the mod; blocked where the mod cannot run), `block` (always blocked, with an obfuscated version to send), `warn` (sent as typed, with a notice), `off` | `rewrite` |
| `toolOutput` | Obfuscate tool results | `true` |
| `wordlistsInToolOutput` | Apply the name lists to tool results too. Turn off if they add noise in code; memory and rules still apply | `true` |
| `restoreLocalTools` | Put real values back for local tools | `true` |
| `networkCommands` | `ask` or `allow` for network-capable commands that receive real values | `ask` |
| `outbound` | `deny`, `ask` or `allow` for web and MCP tools whose input contains sensitive data | `deny` |
| `localMcpServers` | MCP servers that run locally and may receive real values, e.g. `["sqlite"]` | `[]` |
| `restoreDisplay` | Show real values in replies on your screen | `true` |
| `checkClaudeMd` | Warn about sensitive data in `CLAUDE.md` files at session start | `true` |
| `rules`, `memory`, `allowlist`, `exceptionsExtra`, `wordlists`, `dismissedRules` | Same format as the browser extension | |

## Limitations

Trellis only sees what passes through hooks. Know what it does not cover:

- **Files attached with `@`** are added by Claude Code without a tool call. With the mod (2.1.290 or later) they are
  read from an obfuscated copy; on earlier versions Trellis can only check them and block the prompt. The path you
  type after `@` is sent as typed.
- **`CLAUDE.md` and other context loaded automatically** (memory files, the git status Claude Code adds to the
  system prompt) are sent as they are. Trellis warns about `CLAUDE.md` files, but cannot change them.
- **The built-in `Edit` tool cannot use placeholders** (see above); those edits go through Trellis's `edit` and
  `multi_edit` tools.
- **Prompts are only rewritten by the mod** (Claude Code 2.1.287 or later, and not where mods do not run, such as a
  WSL session of the Desktop app); elsewhere they are blocked and you get an obfuscated version to send.
- **Tool errors** cannot be rewritten by hooks: an error message that quotes sensitive data reaches Claude.
- **Images and PDFs** are not inspected.
- **Detection is pattern based.** It will miss data that matches no rule, list or memory term, and can hide words
  that are not sensitive (use `/trellis:allow`). The name lists can obfuscate capitalized identifiers in code
  (`wordlistsInToolOutput: false` turns them off for tool results).
- **Deliberate evasion is not covered.** Trellis prevents accidental exposure. A model or a prompt injection that
  sets out to leak data can still do it, for example by printing a file base64-encoded: encoded output matches no
  rule.
- **Local files and commands get real values.** That is the point, but it means a script Claude writes can still
  use them. Network-capable commands ask first; other ways out (a test that sends email, a build that uploads)
  cannot be detected.
- **Literal placeholders.** Text that already looks like a known placeholder (`[EMAIL_1]`) is restored when Claude
  writes it to a file.
- **Memory terms** in `settings.json` are not encrypted (the vaults are).
- **Local transcripts** (`~/.claude/projects/`) and your terminal history may contain original values (the prompts
  you typed, and the log of what the hooks returned); they stay on your machine and are not sent to Claude.

## Development

```bash
npm test                         # unit tests: feed hook JSON to scripts/hook.js on stdin
claude plugin test .             # the mod, with Claude Code's mod test kit (test/*.test.ts)
npm run test:audit               # traffic audit: real Claude Code + Trellis against a recording stand-in API
claude plugin validate .         # check the manifests
claude --plugin-dir .            # try it without installing
```

The traffic audit runs the installed `claude` (or `CLAUDE_BIN`) with this plugin against `test/audit/fake-api.js`, a
local stand-in for the Anthropic API that records every request and answers from a script (tool calls included; the
auto-mode classifier is told to allow). Each scenario then checks that no recorded request holds any of the original
values, and that the commands Claude ran used the real ones: a prompt with an `@` attachment, tool results and a
shell command, auto mode, and proxy mode with a `CLAUDE.md`. No account, cost or network; CI runs it on every push.
With Trellis disabled, every scenario fails.

The detection engine is shared with the [browser extension](https://github.com/daffi1238/Trellis): `lib/obfuscator.js`,
`wordlists/`, `lib/default-rules.json`, `lib/outdated-patterns.json` and `THIRD_PARTY_NOTICES.md` are copied from it,
never edited here. Change them in Trellis, then:

```bash
npm run sync-engine -- --from ../Trellis     # copy the engine, word lists and default rules
npm run check-engine -- --from ../Trellis    # only compare (exit 1 if they differ)
```

CI runs the check against Trellis's `main` on every push and every Monday, so a change to the engine in Trellis
shows up here as a failing check until it is synced.

## License

MIT
