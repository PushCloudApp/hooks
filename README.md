# PushCloud hooks for coding agents

Approve your agent's tool calls from your phone. When your agent hits something
it needs permission for, your lock screen gets the command with Approve, Deny and
a reply box on it. Answer, and the run carries on.

If you don't answer, nothing happens: you get the normal terminal prompt, exactly
as if this were not installed. It never approves anything on your behalf.

## Pair

On your phone, open PushCloud, add a source and choose your agent. It shows a
six digit code. Then, on the machine your agent runs on:

```sh
npx pushcloud pair 482913
```

Tap **Connect** on your phone and that is it. Pairing writes the hooks, registers
the PushCloud MCP server with your agent, installs the skill, and sends a test
question you answer on your phone. Nothing is written to disk until you tap
Connect, and a code is single use and lasts ten minutes.

Agents are free on every plan.

### Claude Code

Pair wires the `PreToolUse` approval hook, session reporting, the MCP server
(`claude mcp add`) and the skill in `~/.claude/skills/pushcloud/`.

### Codex

Pair registers the MCP server (`codex mcp add`, or `~/.codex/config.toml`) and hooks
`PermissionRequest`, so approvals come to your phone.

### Cursor

Pair registers the MCP server in `~/.cursor/mcp.json` and hooks
`beforeShellExecution`.

### Other

Any agent that speaks MCP can use PushCloud. Choose **Other** on your phone: it
shows the MCP server URL and the header to send, and pair writes nothing.

## Setup (manual)

If you cannot pair, `setup` does the same by hand:

```sh
npx pushcloud setup
```

It asks for one credential, an **application token** (`pca_...`), from the
source's page in the PushCloud panel. It checks it, sends a test question to
your phone, writes the hooks, and then waits for you to answer it.

Some accounts also need an **API key** (`pck_...`, `read` scope, from Settings)
to wait for answers. Setup finds out by itself and only then asks for one.
Pass `--token` (and `--key`) to skip the prompts.

Credentials go to `~/.pushcloud/config.json`, readable only by you. Not into
`settings.json`, which people commit to repos.

### Commands

| | |
| --- | --- |
| `pair <code>` | Connect this machine with the code from your phone. |
| `setup` | The manual path: token, verify, write, and prove it works. |
| `test` | Send another test question. Use this if the first one never arrived. |
| `remove` | Take the hooks back out, leaving everything else in the file alone. |

Useful flags: `--token`, `--key`, `--machine`, `--matcher`, `--no-test`,
`--claude-settings PATH`, `--config PATH`. Run `help` for the full list.

## What to route through it

The default is `Bash` only. A matcher of `.*` sends you a push for every file
read, and you will turn the whole thing off within an hour. Tools you have
already allowlisted never reach a hook at all, so the matcher is the only lever
you have.

## What ends up on your phone

The title is your machine and the project directory. The body is the command for
`Bash`, or the path for a file tool, truncated to 300 characters.

That means **the command text leaves your machine and appears on a lock screen**.
If your commands carry secrets inline, that is worth a thought.

Three answers, not two: Approve, Deny, and a reply box. Typing an answer denies
the call and passes your words to Claude, so "no, rebase instead" works and it
gets to act on the reason rather than guessing.

## Settings

Everything in `~/.pushcloud/config.json` can be overridden by an environment
variable, which is what CI and a second account should use.

| Variable | Config key | Default |
| --- | --- | --- |
| `PUSHCLOUD_TOKEN` | `token` | none |
| `PUSHCLOUD_KEY` | `key` | none (only some accounts need one) |
| `PUSHCLOUD_MACHINE` | `machine` | none |
| `PUSHCLOUD_WAIT_SECONDS` | `wait_seconds` | `120` |
| `PUSHCLOUD_API` | `api` | `https://pushcloud.app` |
| `PUSHCLOUD_CONFIG` | | `~/.pushcloud/config.json` |
| `PUSHCLOUD_E2EE_KEY` | `e2ee_key` | none |

If you change `wait_seconds`, the `timeout` on the `PreToolUse` hook in
`settings.json` must stay larger than it, or Claude Code kills the hook while
you are still looking at the question.

## The skill

Pair and setup also write a skill to `~/.claude/skills/pushcloud/`. The hooks make an agent able
to reach you; the skill is what tells it *when* it should - stop and ask before something
irreversible, say so when a long task finishes, and read a denial's reason rather than
trying a variation of the thing you just refused.

It is a plain markdown file. Read it, and edit it if you disagree with any of it.

## Which agents

| Agent | Event | Approve from phone |
| --- | --- | --- |
| Claude Code | `PreToolUse` | yes |
| Cursor | `beforeShellExecution` | yes |
| Codex | `PermissionRequest` | yes |
| Gemini CLI | | no, see below |

`setup` wires up whichever of the first three it finds, and leaves the rest alone.

**Codex** is hooked on `PermissionRequest`, not `PreToolUse`. Its `PreToolUse`
parser rejects an `allow` that has no `updatedInput`, and rejects `ask`
outright, so a hook there could only ever say no.

**Gemini CLI** is detected and deliberately not wired up. Its hooks can block a
tool call and nothing more: there is no way for a hook to grant permission or to
defer to the user. A phone that can only say no, while Gemini prompts in the
terminal regardless, is worse than not offering it at all.

## Encryption

Give setup an encryption key and every command is sealed with AES-256-GCM before
it leaves your machine. The server stores bytes it cannot read; only your phone
has the key. Generate one under Settings in the panel.

Two things this does not cover, so that nobody assumes otherwise: the button
labels stay readable, because iOS needs them to draw the notification without
the key; and the answer coming back is not encrypted, so a typed reply travels
as plaintext.

## Tests

```sh
npm test
```

No dependencies, and none are wanted. This runs before every tool call on
somebody's machine.
