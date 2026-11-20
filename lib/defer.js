// Defer: you aren't ready to answer, so the agent is told to hold off and the card leaves the board until you
// comes back to that chat (or taps Resume). The exact words are fixed by the design.
export const DEFER_MESSAGE = "Let's hold off on this for now. Please pause here and don't take any further action until I come back to it.";
export const RESUME_MESSAGE = "Let's pick this back up where we left off.";

/**
 * Whether the board offers Defer on a card: Blocked or Review, the board can type into it, it isn't already closed,
 * and it isn't a menu the board can't answer (those have to be handled in the terminal).
 */
export function canDefer(card) {
  return !!card.canReply && ['blocked', 'review'].includes(card.status) && !card.question?.unsupported && !card.closedAt
    && !(card.pendingPrompt && card.menuEscSafe === false);
}

const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();

/**
 * Why Defer must not go ahead (a message), or null: the page sends the menu you saw (`expectPrompt`, `expectText`);
 * if the card on the server now shows a different menu, or a menu appeared or went away, nothing is pressed.
 */
export function deferMismatch(card, { expectPrompt, expectText }) {
  const now = card.question?.expect || card.pendingPrompt || '';
  if (!!card.pendingPrompt !== !!expectPrompt || (expectPrompt && norm(now) !== norm(expectText))) {
    return 'The question on this card changed since you looked. Nothing was sent. Refresh and check it again.';
  }
  return null;
}
