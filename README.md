# PushCloud hooks for coding agents

Approve your agent's tool calls from your phone. When Claude Code hits something
it needs permission for, your lock screen gets the command with Approve, Deny and
a reply box on it. Answer, and the run carries on.

If you don't answer, nothing happens: you get the normal terminal prompt, exactly
as if this were not installed. It never approves anything on your behalf.

## Setup

```sh
node src/setup.mjs setup
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

## Other agents

Cursor, Codex and Gemini CLI are detected and reported, but not yet wired up.
Claude Code is the only one with hooks today.

## Tests

```sh
npm test
```

No dependencies, and none are wanted. This runs before every tool call on
somebody's machine.
