# PushCloud hooks for Claude Code

Approve Claude Code's tool calls from your phone. When Claude hits something it
needs permission for, your lock screen gets the command with Approve and Deny on
it. Tap one and the run carries on.

If you don't answer, nothing happens: you get the normal terminal prompt, exactly
as if this were not installed. It never approves anything on your behalf.

## Setup

Two credentials, from the PushCloud panel:

- an **application token** (`pca_...`), from the application you want these
  notifications to come from. This sends the question.
- an **API key** (`pck_...`) with the `read` scope, from Settings. This waits for
  your answer.

They are separate because an application token deliberately cannot read your
account, and a hook only needs to read the one answer it is waiting on.

```sh
export PUSHCLOUD_TOKEN=pca_...
export PUSHCLOUD_KEY=pck_...
export PUSHCLOUD_MACHINE=$(hostname -s)   # optional, names the machine on the push
```

Then in `~/.claude/settings.json`, or a project's `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/tools/agent-hooks/src/pushcloud-hook.mjs ask",
            "timeout": 130
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/tools/agent-hooks/src/pushcloud-hook.mjs notify"
          }
        ]
      }
    ]
  }
}
```

The `timeout` must be larger than `PUSHCLOUD_WAIT_SECONDS` (120 by default), or
Claude Code kills the hook while your finger is on the button.

## What to route through it

Start with `Bash` only. A matcher of `.*` sends you a push for every file read,
and you will turn the whole thing off within an hour. Tools you have already
allowlisted never reach a hook at all, so the matcher is the only lever you have.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `PUSHCLOUD_TOKEN` | none | Application token (`pca_`) that sends the question. |
| `PUSHCLOUD_KEY` | none | API key (`pck_`) with the `read` scope, which waits for the answer. Without either credential the hook only ever falls through. |
| `PUSHCLOUD_WAIT_SECONDS` | `120` | How long to hold the terminal waiting for a tap. Max 300. |
| `PUSHCLOUD_MACHINE` | none | Name shown on the push, so three machines are tellable apart. |
| `PUSHCLOUD_API` | `https://pushcloud.app` | Override the origin. |

## What ends up on your phone

The title is your machine and the project directory. The body is the command for
`Bash`, or the path for a file tool, truncated to 300 characters.

That means **the command text leaves your machine and appears on a lock screen**.
If your commands contain secrets inline, that is worth a thought before you wire
this to a shared or borrowed phone.

Three answers, not two: Approve, Deny, and a reply box. Typing an answer denies
the call and passes your words to Claude, so "no, rebase instead" works and it
gets to act on the reason rather than guessing at it.

## Tests

```sh
npm test
```

No dependencies, and none are wanted. This runs before every tool call on
somebody's machine.
