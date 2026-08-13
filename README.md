# PushCloud hooks for coding agents

Approve your agent's tool calls from your phone. When your agent hits something
it needs permission for, your lock screen gets the command with Approve, Deny and
a reply box on it. Answer, and the run carries on.

If you don't answer, nothing happens: you get the normal terminal prompt, exactly
as if this were not installed. It never approves anything on your behalf.

## Setup

```sh
npx pushcloud setup
```

It asks for two credentials, checks them, writes the hooks, and then sends a
question to your phone that you have to answer before it says it worked.

The two credentials, both from the PushCloud panel:

- an **application token** (`pca_...`), from the application these notifications
  should come from. This sends the question.
- an **API key** (`pck_...`) with the `read` scope, from Settings. This waits for
  your answer.

They are separate because an application token deliberately cannot read your
account, and a hook only needs to read the one answer it is waiting on.

Credentials go to `~/.pushcloud/config.json`, readable only by you. Not into
`settings.json`, which people commit to repos.

### Commands

| | |
| --- | --- |
| `setup` | Ask, verify, write, and prove it works. |
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
| `PUSHCLOUD_KEY` | `key` | none |
| `PUSHCLOUD_MACHINE` | `machine` | none |
| `PUSHCLOUD_WAIT_SECONDS` | `wait_seconds` | `120` |
| `PUSHCLOUD_API` | `api` | `https://pushcloud.app` |
| `PUSHCLOUD_CONFIG` | | `~/.pushcloud/config.json` |

If you change `wait_seconds`, the `timeout` on the `PreToolUse` hook in
`settings.json` must stay larger than it, or Claude Code kills the hook while
you are still looking at the question.

## Which agents

| Agent | Event | Approve from phone |
| --- | --- | --- |
| Claude Code | `PreToolUse` | yes |
| Cursor | `beforeShellExecution` | yes |
| Codex | `PermissionRequest` | yes |
| Gemini CLI | | no, see below |

Setup wires up whichever of the first three it finds, and leaves the rest alone.

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
