---
name: pushcloud
description: Use when a task will outlast the person's attention, when you are blocked on a decision only they can make, or when something has failed and waiting silently would waste their time. Reaches them on their phone and, for a question, waits for the answer.
---

# Reaching a human who is not at the screen

The person who started this is often not watching. PushCloud is how you reach them
anyway: a notification on their phone, and for a question, buttons they can answer from
the lock screen.

## The rule

**Ask rather than assume, and tell rather than finish silently.**

An agent that guesses at a decision and carries on produces work that has to be
unpicked. An agent that stops and waits, with nobody watching, produces nothing at all.
Both are avoidable.

## When to reach for it

Send a notification when:

- a long task finishes, so they can come back to it
- something failed in a way that will not fix itself
- you are about to stop and would otherwise leave the terminal idle

Ask a question when:

- the choice is theirs, not yours: what to name a thing, which approach to take, whether
  the risk is acceptable
- an action is irreversible or hard to undo: deleting data, force-pushing, deploying,
  spending money, touching production
- you are genuinely uncertain, and a wrong guess costs more than a two-minute wait

Do **not** ask when:

- the answer is in the codebase, the task, or this conversation. Go and look first.
- it is a detail they have already delegated. Asking about every variable name is how a
  useful tool becomes a muted one.
- you are only seeking reassurance. Do the work.

The test: *would a careful colleague interrupt someone's evening for this?*

## How

**With the MCP tools connected** (preferred, because the answer comes back to you):

| Tool | For |
| --- | --- |
| `ask_human` | A decision. The risk, the options and the deadline are separate fields, and it waits for the answer. |
| `send_and_wait` | A question that is not a decision. Up to four buttons, or a reply box. |
| `send_notification` | Something they need to know but need not answer. |
| `get_interaction_status` | Poll a question that timed out. It is still live on their phone. |

Prefer `ask_human` over `send_and_wait` for anything that is genuinely a decision: the
person gets the stakes and the options as what they are, rather than buried in prose.

A timeout is not a no. It means they have not looked yet, and the question is still
waiting on their phone. Say so, and either wait again or stop and leave it for them.

**Without MCP**, `npx pushcloud setup` installs a permission hook, and their phone is
asked automatically whenever you need approval for a tool call. Nothing to call.

## Writing the notification

It is read on a lock screen, in a queue, by someone doing something else.

- The title says where it came from. The body says what happened.
- Lead with the decision, not the preamble. "Force-push to main?" beats "I have been
  working on the refactor and have reached a point where...".
- Include what you would do if they said nothing.
- Reserve high priority for something that should genuinely interrupt them. Everything
  marked urgent means nothing is.

## After the answer

Do what they said. A reply that denies with a reason is an instruction: read it, and act
on the reason rather than trying a variation of the thing they just refused.

If they said no and gave no reason, stop and ask what they would prefer. Do not work
around a refusal.
