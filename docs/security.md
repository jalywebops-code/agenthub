# Security

AgentHub can act on your AI agents, so it is built to be reachable only by you.

## Who can open it

- **A PIN on every device**, the computer itself included (being on the computer proves nothing: any program there
  could call the board). 8 to 12 digits, stored only as a salted hash in `.data/pin`. Set or reset it with
  `npm run set-pin` in a terminal; changing it signs out every other device.
- **Wrong PINs are limited:** 5 per device per 10 minutes, and 20 per 10 minutes across all devices. Wrong PINs and
  logins are logged in `.data/actions.log`.
- **A login lasts a year** in a cookie that only this site can read (HttpOnly, SameSite=Strict, Secure over HTTPS).
- **Only private networks:** this computer, Tailscale, and (only if you switch it on) your home Wi-Fi or another
  private address you choose. Requests are accepted only for the board's own host names. See
  [phone access](phone-access.md).

## Who can make it act

Anything that acts (answer, approve, reply, end, new chat, hand off, settings, restart) needs the board page itself:
the server checks the page's origin and an action token handed out only with the login and kept in the page's own
storage, never in a cookie. A script with no browser login gets nothing, and a login cookie leaked to another site
on the same host name can read but can't act. Every action asks for a confirmation (Continue and Continue at a reset
time are one tap, with Undo or Cancel instead) and is logged in `.data/actions.log`.

Program paths, folders, ports, Claude accounts, default models and phone access can only be changed from the
computer AgentHub runs on. The server decides that from the connection itself: it must come over the computer's own
loopback, not be forwarded (so Tailscale's HTTPS proxy, which also arrives over loopback, counts as a phone), and ask
for `localhost` by name.

## What leaves your computer

- **Plan usage (optional):** to draw the Claude usage rings, the board asks Anthropic for each Claude account's usage
  every 5 minutes, using that account's own sign-in from the macOS Keychain (or Claude Code's credentials file). The
  sign-in is only sent to Anthropic; it is never logged, stored, shown or renewed by the board. Switch the rings off
  in Settings to stop this.
- **Link previews:** only when you tap one, headless Chrome on your computer opens the link (a fresh empty profile
  every time, never your browser's) and screenshots it. Machines on your private network are never opened this way.
- Everything else (cards, chats, settings, images, logs) stays on your computer.

## Agents and their instructions

When one agent's words are passed to another (Hand off, Have Hermes do it, a helper's report sent back), they are
quoted between random markers with an instruction not to follow anything inside, and only your own typed text is the
instruction. Nothing is passed on without your confirmation.

## Keep private

`.data/` holds your setup, PIN hash, signing secret and logs; `private/` your own notes. Neither is ever committed.
A program running as you can read them, so keep your computer account to yourself.

## Reporting a problem

If you find a security problem, please report it privately to the maintainers rather than in a public issue.
