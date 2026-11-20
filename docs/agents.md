# Agents on the board

Each agent gets a button in the top bar and a lane of cards. A card is one chat. Its status says what it needs:

| Status | Meaning |
|---|---|
| Blocked | The agent can't go on until you act: an approval, a question, a request |
| Review | The agent handed you something: work to look at, a go-ahead to give, a choice |
| Update | A report with nothing for you to do (it stays in its project, not in **Needs you**) |
| Running | The agent is working |

Blocked and Review cards are collected in **Needs you** at the top; **Active** shows what else moved in the last day.

## What you can do from a card

- **Answer / Approve / Changes / Reply**: what fits the card. Approvals are answered only if the question on screen is
  still exactly the one you saw; otherwise nothing is sent and you're asked to look again.
- **Review**: open what the agent made (links, local files, previews), then say it's good or ask for changes.
- **Continue**: push an agent that stopped with a report on to its next gate. The button turns into **Undo** for five
  seconds first.
- **Continue at <time>**: when a chat stopped on a usage limit, the board sends Continue a couple of minutes after the
  limit resets. The board's server sends it, so your page can be closed. It is only sent if the chat is still where
  you left it.
- **Defer**: tell the agent to hold off; the card moves to Closed until you write in that chat again or tap Resume.
- **Ask**: a side question to any agent about the chat, answered read-only (nothing is done).
- **Hand off**: move the task to another agent, which starts a new chat and owns it; the first agent is told to stop.
- **Have Hermes do it**: when a chat asks you to do one thing (run a command, grant something), Hermes does just that
  task in its own chat; when it's done you check its report and send it back. The asking chat keeps its task.
- **Suggest a reply**: in the reply box, asks for the reply you'd most likely send. Only when you press it.

Nothing is sent to an agent without a confirmation, except Continue (one tap, with Undo) and Continue at a reset time
(one tap, with Cancel until it goes).

## Claude Code and Codex: chats in tmux

The board reads every Claude Code and Codex chat on your computer, but it can only type into chats running inside
tmux. Start them with **New chat** on the board, or in a terminal with the `ah` helper:

```bash
bin/ah claude ~/projects/example     # Claude Code in that folder, inside tmux
bin/ah codex .                       # Codex in the current folder
bin/ah ls                            # list running sessions
bin/ah attach <name>                 # reattach (detach again with Ctrl-b, then d)
```

Chats started any other way are read-only on the board; their cards say so.

When a chat shows a terminal menu (a permission or approval), the card shows the menu. **Approve** picks "Yes";
**Changes** presses Esc and types your request (only on menus where Esc doesn't quit). Menus the board can't answer
safely are shown, but you answer them in the terminal.

### Several Claude Code accounts

Each Claude Code account is its own lane: the command that runs it and its own config folder (`~/.claude` for the
default one, another folder for each extra login, set with `CLAUDE_CONFIG_DIR` or a small wrapper script). Add them in
Settings → Agent settings → **Add a Claude account…**. If the command is a wrapper that takes the project folder as
its first argument, tick "takes the project folder first".

A chat belongs to the account whose config folder it was started with. Suggested replies for it are written by that
same account unless you choose another in Settings.

To tell the accounts apart, give each one a short **tag** and a **colour** (Edit… on the account): its button then
reads "Claude" with the tag as a small coloured badge (e.g. a green JWS and a blue WORK), and its cards carry the same
badge by the folder. The default account (the plain `claude` command) is always just "Claude".

### Plan usage

Claude Code and Codex buttons show how much of the current session (5-hour) and weekly window is used: the outline
drains as the fuller of the two fills, amber from 75% and red from 90%. Hover or press and hold the button for the
numbers and reset times. Codex's numbers come from its own logs. Claude's come from the same place Claude Code's
`/usage` screen gets them, asked with that account's own sign-in; that is not a published interface, so the ring
disappears if it changes. Switch the rings off in Settings → Agent settings.

## Hermes

The board reads Hermes's chats through its dashboard (127.0.0.1:9119) and answers through the Hermes gateway that is
already running, the same backend the Hermes app uses. It never starts a gateway: if Hermes isn't running, its cards
are read-only and say why. Messages are queued (a busy chat finishes its turn first) and each carries a unique id,
so a retry never runs twice. Chats from other channels (Slack, Telegram, kanban) are read-only.

## OpenClaw

The board talks to the OpenClaw gateway (port 18789 unless OpenClaw's own settings say otherwise) with OpenClaw's own
command: it lists sessions, reads their history and sends messages.

## Lights

The light on each agent button says whether the board can act on that agent right now: green ready, grey nothing
running, orange restarting, red down (the agent isn't running, or the board can't find or reach it). Hover or press
and hold the button for the reason.
