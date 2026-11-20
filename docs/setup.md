# Setting up AgentHub

AgentHub is a control board for the AI agents running on your own computer: Hermes, OpenClaw, Claude Code (one or
more accounts) and Codex. It shows what each one is doing and what is waiting on you, and lets you answer from any
browser, phone included. It is plain Node with no dependencies, and your data stays on your computer.

## Requirements

- macOS or Linux.
- Node.js 20 or newer.
- tmux, so the board can answer Claude Code and Codex chats (`brew install tmux`, or `sudo apt install tmux`).
- At least one agent: Claude Code, Codex, Hermes or OpenClaw.
- Optional: Google Chrome or Chromium, for link previews (found by itself on Linux; without it, previews say so).
- Optional: Tailscale, to open the board from your phone ([phone access](phone-access.md)).

## Install

```bash
git clone https://github.com/jalywebops-code/agenthub.git
cd agenthub
npm start
```

Open http://localhost:4400 on the same computer. A short welcome takes it from there:

1. **Choose your PIN** (8 to 12 digits). Every device logs in with it once. It can only be created like this on the
   computer AgentHub runs on; elsewhere, or over SSH, use `npm run set-pin`.
2. **Your agents.** One card each for Claude Code, Codex, Hermes and OpenClaw, saying where it stands and what to do
   next: install it (with a link to its page), sign in or set it up (the exact command), start it, or nothing (ready).
   Tick the ones you use. **Check again** after you fix something. tmux is checked too.
3. **Your phone** (optional): AgentHub already works on this computer; see [phone access](phone-access.md).
4. **Start with your computer:** one button, the same as `npm run install-service`.

You can open the welcome again any time: Settings → Agents → Setup guide. Behind it, AgentHub keeps its setup in
`.data/setup.json`; the first start already ran **Detect**, which fills in what it finds and switches off agents it
doesn't find.

## Start at login

```bash
npm run install-service      # start at login and restart after a crash
npm run uninstall-service    # remove it again
```

On macOS this is a launchd agent called `local.agenthub`; on Linux a systemd user service called `agenthub`
(`systemctl --user status agenthub`). Pass `-- --label <name>` for another name (it must end in `agenthub`). When
Hermes is on, a second helper keeps Hermes's dashboard running on 127.0.0.1:9119 for the board. Don't run `npm start`
as well while the service is installed: both would want port 4400.

## On a server

AgentHub runs on a Linux server too (a cloud droplet, a home server), with your agents installed there. Over SSH:

```bash
sudo apt install tmux                     # plus Node.js 20 or newer
git clone https://github.com/jalywebops-code/agenthub.git && cd agenthub
npm run set-pin
npm run setup                             # finds your agents and asks before saving each finding
npm run install-service
loginctl enable-linger $USER              # keep it running when you're not logged in
```

Everything else is in Settings. Open them from your own computer through an SSH tunnel, which makes your browser count
as the server itself (so computer-only settings can be changed):

```bash
ssh -L 4400:localhost:4400 <your server>    # then open http://localhost:4400
```

From your phone, use Tailscale on the server ([phone access](phone-access.md)). Never open port 4400 to the internet.

## Settings

Everything else is in **Settings** (the gear):

- **Board:** the default time window and which projects start folded.
- **Agent settings:** each agent on or off, the model New chat starts Claude Code and Codex with, which Claude
  account and model write suggested replies, and the plan-usage rings. **Detect** finds agents again later and
  proposes fixes for anything missing or broken (it never replaces a path that works).
  - **Paths…** per agent and **Edit…** per Claude account: program commands, folders, ports.
  - **Add a Claude account…** for a second (or third) Claude Code login: its command and its own config folder
    (see [agents](agents.md#several-claude-code-accounts)).
- **Projects:** how chats group into projects. Every folder in your projects folder is a project unless you put
  several in a group or leave some out.
- **Phone access:** where the board can be opened, and how to reach it from your phone.
- **On this device** (under Board): **Appearance** (match this device, light or dark; the sun/moon button in the header
  switches too) and **Style** (classic, or the embossed tactile look), and hiding an agent on this device only (handy
  before sharing a screenshot). These are kept per device. `?theme=light|dark` and `?style=classic|tactile` in the
  address set them too.
- **PIN:** change it (every other device is signed out).

Program paths, folders, ports, Claude accounts, default models and phone access can only be changed on the computer
AgentHub runs on, never from a phone. Every change asks for a confirmation, is logged in `.data/actions.log`, and
restarts the board to apply it (a few seconds; the page reconnects by itself).

## Files

| Where | What | Shared? |
|---|---|---|
| `.data/` | Your setup, PIN hash, settings, logs of actions, caches | Never: keep it private |
| `logs/` | The server's log | Never |
| `private/` | Your own notes, specs and plans (git ignores it) | Never |
| `setup.local.json` | Optional: a starting setup for a brand-new install, read once (git ignores it) | Never |
| everything else | The board itself | Yes |

## Updating

Pull the new version and restart the board (Settings → Restart AgentHub, or `npm start` again). Your setup in
`.data/` is kept; new settings get their defaults.
