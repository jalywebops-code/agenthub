// Slash commands per agent: a shortcut into each agent's OWN commands, not a new command system.
// Hermes and OpenClaw report their catalogs live (their gateways list them); Claude Code and Codex
// have no such API, so their lists below were read from the versions installed on this computer
// (Claude Code 2.1.325, Codex 0.153.4). Commands that delete, log out, quit or only change the
// local terminal's look are left out: they make no sense from a phone.

const CLAUDE = [
  ['/plan', 'Turn on plan mode or view the plan'],
  ['/goal', 'Set a goal Claude checks before stopping'],
  ['/compact', 'Free up context by summarizing the conversation so far'],
  ['/clear', 'Start a new session with empty context (the old one stays resumable)'],
  ['/model', 'Set the AI model for Claude Code'],
  ['/effort', "Set the model's effort level"],
  ['/context', 'Show what fills the context'],
  ['/btw', 'Ask a side question without interrupting Claude'],
  ['/status', 'Show version, account, model, MCP servers and setup warnings'],
  ['/usage', 'Show session cost, plan usage, and activity stats'],
  ['/recap', 'Generate a one-line session recap now'],
  ['/rename', 'Rename the current conversation'],
  ['/permissions', 'Manage allow and deny tool permission rules'],
  ['/memory', 'Edit CLAUDE.md files and memory settings'],
  ['/skills', 'List available skills'],
  ['/mcp', 'Manage MCP servers'],
  ['/tasks', 'View and manage everything running in the background'],
  ['/subtask', 'Send a subagent off with your full context; its result comes back here'],
  ['/add-dir', 'Add a working directory'],
  ['/branch', 'Create a branch of the current conversation at this point'],
  ['/export', 'Export this session to a file or clipboard'],
  ['/help', 'Show help and available commands'],
];

const CODEX = [
  ['/plan', 'Switch to Plan mode'],
  ['/goal', 'Set or view the goal for a long-running task'],
  ['/compact', 'Summarize conversation to prevent hitting the context limit'],
  ['/new', 'Start a new chat during a conversation'],
  ['/model', 'Choose what model and reasoning effort to use'],
  ['/fast', '1.5x speed, increased usage'],
  ['/permissions', 'Choose what Codex is allowed to do'],
  ['/review', 'Review my current changes and find issues'],
  ['/diff', 'Show git diff (including untracked files)'],
  ['/status', 'Show current session configuration and token usage'],
  ['/usage', 'View account usage or use a usage limit reset'],
  ['/recap', 'Summarize the current conversation now'],
  ['/side', 'Start a side conversation in an ephemeral fork'],
  ['/init', 'Create an AGENTS.md file with instructions for Codex'],
  ['/rename', 'Rename the current thread'],
  ['/fork', 'Fork the current chat'],
  ['/resume', 'Resume a saved chat'],
  ['/mention', 'Mention a file'],
  ['/skills', 'Use skills to improve how Codex performs specific tasks'],
  ['/mcp', 'List configured MCP tools'],
  ['/agents', 'View and switch between all active agent sessions'],
  ['/ps', 'List background terminals'],
  ['/pwd', 'Show the current working directory'],
  ['/cd', 'Change the current working directory'],
  ['/export', 'Export the conversation as markdown'],
  ['/memories', 'Configure memory use and generation'],
];

const toList = (pairs) => pairs.map(([name, description]) => ({ name, description }));

export const STATIC_COMMANDS = { claude: toList(CLAUDE), codex: toList(CODEX) };
