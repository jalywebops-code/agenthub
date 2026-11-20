// A stand-in for tmux in tests: records every command instead of running it, so no test can ever press keys or paste
// text into a real pane. `paneIs` sets what the pane reports it is running ("claude", or "zsh" once an agent quit).
import { _setTmux } from '../../lib/tmux.js';

export function fakeTmux({ paneIs = 'claude' } = {}) {
  const calls = [];
  const fake = { calls, paneIs };
  _setTmux(async (args) => {
    calls.push(args);
    if (args[0] === 'display-message') return `${fake.paneIs}\n`;
    return '';
  });
  /** The keys pressed, in order (send-keys only). */
  fake.keys = () => calls.filter((a) => a[0] === 'send-keys').map((a) => a.at(-1));
  /** The texts put in paste buffers, in order. */
  fake.pasted = () => calls.filter((a) => a[0] === 'set-buffer').map((a) => a.at(-1));
  fake.reset = () => { calls.length = 0; };
  return fake;
}
