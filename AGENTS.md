# AgentHub — rules for coding agents

- **Design specs and plans go in `private/`** (`private/specs/`, `private/plans/`), never under `docs/`.
  `private/` is ignored by git; `docs/` is public and only holds documentation for people using AgentHub.
- Never commit `.data/` (PIN hash, settings, agent setup), `private/` or `logs/`.
- No personal details in code, tests or docs: no names, emails, addresses, client or project names.
  Use neutral examples ("you", `~/projects/example`, `example.ts.net`).
