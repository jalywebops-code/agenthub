# Opening AgentHub from your phone

AgentHub listens on your own computer (http://localhost:4400). To use it from a phone, reach that computer over a
private network. Settings → **Phone access** lists every address the board can be opened at right now.

## Tailscale (recommended)

1. Install [Tailscale](https://tailscale.com) on the computer AgentHub runs on (your Mac, or a Linux server) and on
   your phone, signed in to the same account.
2. On your phone, open the computer's Tailscale address on port 4400 (shown in Settings → Phone access).
3. For HTTPS, which the phone's microphone needs, run this once on the computer:

   ```bash
   tailscale serve --bg --https=4443 4400
   ```

   Then open the Tailscale HTTPS address it prints (port 4443). Using port 4443 leaves anything you already share on
   Tailscale's default HTTPS port as it is.

Tailscale encrypts everything between your devices, and only devices signed in to your account can reach the board.

### As an app on your Home Screen

In Safari on the phone: Share → **Add to Home Screen**. AgentHub then opens full-screen like an app; pull down from
the top of the board to refresh it.

## Home Wi-Fi

Off by default. Switch it on in Settings → Phone access (on the computer) to open the board on your home network
without Tailscale. It is plain HTTP: your PIN and login travel unencrypted on that network, and the microphone won't
work. Only on a network you trust. Setting `AGENTHUB_LAN=1` for the service also switches it on.

## Other private networks

For ZeroTier, your own WireGuard or similar: Settings → Phone access → **Extra addresses** lists this computer's other
private addresses. Tick the one on that network. Only private addresses this computer has can be used.

## Never the open internet

Don't forward a router port to AgentHub and don't put it behind a public tunnel. Anyone who reaches it can try your
PIN, and the board can act on your agents. Keep it on your own devices and private networks.
