"""AgentHub <-> Hermes bridge. Run by lib/lanes/hermes.js with Hermes's own Python.

It attaches to the Hermes gateway that is ALREADY running (the same backend the Hermes desktop
app uses) through Hermes's own client: a one-use ticket from the owner-only control socket, then
the gateway's session WebSocket. Discovery only: it never starts a gateway.

Usage: python3 -I hermes_bridge.py <command>   (JSON params on stdin, one JSON answer on stdout)

  live     {}                                   live sessions + pending approvals (read-only)
  reply    {key, profile?, text, images?}       queue a message into a session (images: absolute paths of image
                                                files, attached to that message as the Hermes app attaches them)
  approve  {key, profile?, expect, choice?}     answer the pending request shown as `expect` (choice: once by default,
                                                or another of the request's own choices: session / always / deny)
  clarify  {key, profile?, id, qid?, expect, answer}
                                                answer one of Hermes's own multiple-choice questions (clarify tool),
                                                only if that question is still open and reads exactly `expect`
  changes  {key, profile?, expect?, text, images?}
                                                deny the request shown as `expect` (if any), then queue `text`
  btw      {key, profile?, text}                side question over the session, tools denied (read-only)
  side     {key?, text}                         side question on the board's own hidden empty chat (read-only)
  slash    {key, profile?, text}                run one of Hermes's own slash commands in the session
  commands {}                                   Hermes's slash-command catalog (read-only)
  create   {text, cwd?, images?}                start a new chat with a first message (New chat, Handoff, side chat);
                                                Hermes names it (a title would make Hermes reuse an old chat)
  end      {key, profile?}                      end (close) a chat as Hermes's own client does; refused while running
  delete   {key}                                permanently delete one chat (only chats the user named)

How it follows the gateway's session contract (tui_gateway/contracts/canonical_sessions.py):
- A connection may only submit to a session it has resumed, so every action resumes first.
- Every submission carries a fresh submission_id, so a retried send can never run twice.
- The gateway always QUEUES a submission: a busy session finishes its current turn first and
  is never interrupted or steered.
- Afterwards the board detaches WITHOUT an end_reason, which the gateway treats as "a viewer
  leaving": the conversation stays open in Hermes exactly as it was.
"""
import asyncio
import contextlib
import json
import os
import sys
import uuid

HERMES_ROOT = os.environ.get('AGENTHUB_HERMES_ROOT', os.path.expanduser('~/.hermes/hermes-agent'))
sys.path.insert(0, HERMES_ROOT)
os.environ.setdefault('HERMES_HOME', os.path.expanduser('~/.hermes'))
sys._hermes_pin_default_home = True
import hermes_bootstrap  # noqa: E402,F401  sets up Hermes's dependency path, as its launcher does

RPC_TIMEOUT = 30


class BridgeError(Exception):
    pass


def approval_text(a: dict) -> str:
    """The text the board shows for an approval; approve/changes must send back exactly this."""
    parts = [str(a.get(k) or '').strip() for k in ('description', 'command')]
    return '\n\n'.join(p for p in parts if p)


def endpoint():
    from hermes_cli.gateway_runtime import discover_gateway_endpoint
    from hermes_constants import get_hermes_home
    found = discover_gateway_endpoint(get_hermes_home().resolve())
    if found.state != 'ready' or found.endpoint is None:
        detail = f' ({found.detail})' if found.detail else ''
        raise BridgeError(f'Hermes gateway is not ready: {found.state}{detail}')
    return found.endpoint


async def rpc(client, method, **params):
    from hermes_cli.gateway_client import GatewayRPCError
    try:
        return await client.rpc(method, _timeout=RPC_TIMEOUT, **params)
    except GatewayRPCError as e:
        raise BridgeError(f'Hermes refused {method}: {e}') from e


class Attached:
    """Resume a session for the duration of one action, then hand it back as a leaving viewer."""

    def __init__(self, client, key, profile):
        self.client, self.key, self.profile = client, key, profile
        self.snap = None

    async def __aenter__(self):
        params = {'session_id': self.key, 'omit_messages': True}
        if self.profile:
            params['profile'] = self.profile
        self.snap = await rpc(self.client, 'session.resume', **params)
        return self.snap

    async def __aexit__(self, exc_type, *_):
        sub = (self.snap or {}).get('subscription_id')
        if not sub:
            return
        try:
            # No end_reason: only this viewer leaves; the conversation stays open in Hermes.
            await rpc(self.client, 'session.detach', session_id=self.snap['session_id'], subscription_id=sub)
        except Exception:
            if exc_type is None:  # the action worked; a failed hand-back is still worth reporting
                raise
            # Otherwise keep the action's own error, which is what the user needs to see.


def first_approval(snap, expect):
    """The OLDEST pending approval, only if it is exactly what the user saw."""
    pending = [p for p in snap.get('prompts') or [] if p.get('kind') == 'approval']
    if not pending:
        raise BridgeError('Nothing is waiting for approval in that session any more. Refresh.')
    if approval_text(pending[0]) != expect:
        raise BridgeError('The request in Hermes changed since you looked. Nothing was answered. Refresh and check it again.')
    return pending[0]


async def answer(client, snap, prompt, choice):
    await rpc(client, 'approval.respond', session_id=snap['session_id'], prompt_id=prompt['prompt_id'],
              execution_generation=prompt['execution_generation'], choice=choice)


async def attach_images(client, session_id, images):
    """Stage image files on the session, as the Hermes app does; the next prompt.submit carries them (also when
    it waits in the queue behind a running turn)."""
    for path in images or ():
        # Quoted, so a folder name with spaces stays one path (Hermes reads it like a dropped file).
        await rpc(client, 'image.attach', session_id=session_id, path=f'"{path}"')


async def submit(client, snap, text, images=()):
    await attach_images(client, snap['session_id'], images)
    receipt = await rpc(client, 'prompt.submit', session_id=snap['session_id'], text=text,
                        submission_id=f'agenthub-{uuid.uuid4()}', queued=True)
    return receipt.get('status') or 'submitted'


def message(p):
    text = str(p.get('text') or '').strip()
    if not text:
        raise BridgeError('empty message')
    return text


async def cmd_live(client, _p):
    out = []
    for r in (await rpc(client, 'session.active_list')).get('sessions', []):
        key = r.get('session_key')
        if not key:
            continue
        item = {k: r.get(k) for k in ('session_key', 'status', 'last_active', 'title')}
        try:  # a read of the owner's pending-prompt projection; it builds or changes nothing
            res = await rpc(client, 'approval.pending', session_id=key)
            item['approvals'] = [{'request_id': a.get('request_id'), 'text': approval_text(a), 'choices': a.get('choices')}
                                 for a in res.get('approvals') or []]
        except BridgeError as e:
            item['approvals'] = []
            item['approval_error'] = str(e)
        item['clarify'] = []
        # A session blocked on a human but not on an approval may be waiting on a clarify question.
        # Reading it needs a resume (as a viewer that leaves straight away); only done for those sessions.
        if r.get('status') == 'waiting' and not item['approvals']:
            try:
                async with Attached(client, key, None) as snap:
                    item['clarify'] = open_clarify(snap)
            except BridgeError as e:
                item['clarify_error'] = str(e)
        out.append(item)
    return {'sessions': out}


async def cmd_reply(client, p):
    text = message(p)
    async with Attached(client, p['key'], p.get('profile')) as snap:
        return {'status': await submit(client, snap, text, p.get('images'))}


async def cmd_approve(client, p):
    async with Attached(client, p['key'], p.get('profile')) as snap:
        prompt = first_approval(snap, str(p.get('expect') or ''))
        choice = str(p.get('choice') or 'once')
        if choice not in (prompt.get('choices') or ['once', 'deny']):
            raise BridgeError('That choice is not offered by Hermes.')
        await answer(client, snap, prompt, choice)
        return {'status': f'answered {choice}'}


def open_clarify(snap):
    """Hermes's open multiple-choice questions (clarify tool) in a resume snapshot, questions with choices only.

    Two shapes: a single question as a pending prompt (answered with clarify.respond), and the batch form the Hermes
    desktop app and TUI use for their own turns, an open `clarify` request answered one question at a time with
    clarify.lock. For a batch only the next unanswered question is returned (they lock in order).
    """
    out = [{'source': 'prompt', 'id': q.get('prompt_id'), 'execution_generation': q.get('execution_generation'),
            'qid': '', 'question': str(q.get('question') or ''), 'choices': [str(c) for c in q.get('choices') or []],
            'multi_select': bool(q.get('multi_select'))}
           for q in snap.get('prompts') or [] if q.get('kind') == 'clarify' and q.get('choices')]
    for req in snap.get('open_requests') or []:
        if req.get('method') != 'clarify':
            continue
        params = req.get('params') or {}
        answered = params.get('answers') or {}
        nxt = next((q for q in params.get('questions') or [] if q.get('qid') not in answered), None)
        if nxt and nxt.get('choices'):
            out.append({'source': 'batch', 'id': req.get('id'), 'execution_generation': None, 'qid': nxt.get('qid'),
                        'question': str(nxt.get('question') or ''), 'choices': [str(c) for c in nxt['choices']],
                        'multi_select': bool(nxt.get('multi_select'))})
    return out


async def cmd_clarify(client, p):
    async with Attached(client, p['key'], p.get('profile')) as snap:
        open_q = [q for q in open_clarify(snap) if q['id'] == p.get('id') and q['qid'] == (p.get('qid') or '')]
        if not open_q or open_q[0]['question'] != str(p.get('expect') or ''):
            raise BridgeError('Hermes is no longer waiting for that answer (answered, changed or timed out). Nothing was sent. Refresh.')
        q = open_q[0]
        typed = str(p.get('text') or '').strip()
        if typed:
            # A typed answer (Hermes's own "Other (type your answer)" row), e.g. Defer's hold-off message.
            answer = typed
        else:
            answer_value = p.get('answer')
            picked = answer_value if isinstance(answer_value, list) else [answer_value]
            if not picked or any(a not in q['choices'] for a in picked) or (not q['multi_select'] and len(picked) != 1):
                raise BridgeError('That answer is not one of the choices Hermes offered.')
            # Hermes's clarify tool reads a multi-select answer as a JSON array string.
            answer = json.dumps(picked) if q['multi_select'] else picked[0]
        if q['source'] == 'batch':
            res = await rpc(client, 'clarify.lock', request_id=q['id'], question_id=q['qid'], answer=answer)
            if (res or {}).get('status') != 'ok':
                raise BridgeError('Hermes stopped waiting for this answer. Reply in the chat instead.')
            return {'status': 'answered', 'remaining': (res or {}).get('remaining') or []}
        res = await rpc(client, 'clarify.respond', session_id=snap['session_id'], prompt_id=q['id'],
                        execution_generation=q['execution_generation'], answer=answer)
        if (res or {}).get('status') != 'resolved':
            raise BridgeError('Hermes stopped waiting for this answer. Reply in the chat instead.')
        return {'status': 'answered'}


async def cmd_changes(client, p):
    text = message(p)
    async with Attached(client, p['key'], p.get('profile')) as snap:
        denied = False
        if p.get('expect'):
            await answer(client, snap, first_approval(snap, str(p['expect'])), 'deny')
            denied = True
        return {'status': await submit(client, snap, text, p.get('images')), 'denied': denied}


def _find_event(frame, event_type, task_id):
    """The event's payload dict if *frame* is the ``event_type`` event for ``task_id``, else None.
    Event frames carry the type and payload a level or two down, so search the whole frame."""
    if not isinstance(frame, dict):
        return None
    stack = [frame]
    typed = False
    payload = None
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            if event_type in (cur.get('type'), cur.get('event_type'), cur.get('event'), cur.get('method')):
                typed = True
            if cur.get('task_id') == task_id:
                payload = cur
            stack.extend(v for v in cur.values() if isinstance(v, (dict, list)))
        elif isinstance(cur, list):
            stack.extend(cur)
    return payload if typed and payload is not None else None


async def wait_event(client, event_type, task_id, timeout):
    """Wait for the session event that carries the answer to *task_id*."""
    from hermes_cli.gateway_client import GatewayClientError
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        left = deadline - loop.time()
        if left <= 0:
            raise BridgeError('Hermes did not answer in time. Try again in a minute.')
        try:
            frame = await asyncio.wait_for(client.events.get(), left)
        except asyncio.TimeoutError:
            continue
        if isinstance(frame, GatewayClientError):
            raise BridgeError(f'Lost the connection to Hermes: {frame}')
        found = _find_event(frame, event_type, task_id)
        if found is not None:
            return found


async def cmd_btw(client, p):
    """A side question (Hermes's own /btw): answered over a snapshot of the session with every tool
    denied. It never becomes a turn, so the conversation itself is unchanged."""
    text = message(p)
    async with Attached(client, p['key'], p.get('profile')) as snap:
        started = await rpc(client, 'prompt.btw', session_id=snap['session_id'], text=text)
        found = await wait_event(client, 'btw.complete', started['task_id'], float(p.get('timeout') or 170))
        answer = str(found.get('text') or '').strip()
        if answer.startswith('error:'):
            raise BridgeError(f'Hermes could not answer: {answer[6:].strip()}')
        return {'answer': answer}


async def cmd_side(client, p):
    """A side question with no Hermes session behind it (Ask Agent about another agent's card):
    /btw on the board's own hidden, empty "AgentHub side chat", created the first time. /btw never
    adds turns, so that chat stays empty and every tool stays denied."""
    from hermes_cli.gateway_client import GatewayRPCError
    key = str(p.get('key') or '')
    if key:
        try:
            return {**await cmd_btw(client, {**p, 'key': key}), 'key': key}
        except BridgeError as e:
            if not isinstance(e.__cause__, GatewayRPCError) or 'not_found' not in str(e):
                raise
    created = await rpc(client, 'session.create', hidden=True)
    key = created['session_id']
    sub = created.get('subscription_id')
    if sub:
        with contextlib.suppress(Exception):
            await rpc(client, 'session.detach', session_id=key, subscription_id=sub)
    return {**await cmd_btw(client, {**p, 'key': key}), 'key': key}


async def cmd_end(client, p):
    """End a chat the way Hermes's own client closes one: leave it with an end_reason, so the owner
    ends the idle conversation once no other viewer has it open. Refused while a turn is running.
    The chat stays in Hermes's history and can be reopened there."""
    params = {'session_id': p['key'], 'omit_messages': True}
    if p.get('profile'):
        params['profile'] = p['profile']
    snap = await rpc(client, 'session.resume', **params)
    reason = None
    try:
        if snap.get('running'):
            raise BridgeError('Hermes is working in that chat right now. Wait for it to finish, then end it.')
        reason = 'agenthub_close'
    finally:
        await rpc(client, 'session.detach', session_id=snap['session_id'], subscription_id=snap['subscription_id'],
                  **({'end_reason': reason} if reason else {}))
    return {'ended': True}


async def cmd_slash(client, p):
    """Run one of Hermes's own slash commands in a session, exactly as typing it in Hermes would."""
    command = message(p)
    if not command.startswith('/'):
        raise BridgeError('Slash commands start with /')
    async with Attached(client, p['key'], p.get('profile')) as snap:
        result = await rpc(client, 'slash.exec', session_id=snap['session_id'], command=command)
        return {'result': result}


async def cmd_commands(client, _p):
    """Hermes's live slash-command catalog (read-only)."""
    return {'catalog': await rpc(client, 'commands.catalog')}


async def cmd_create(client, p):
    """Start a new Hermes chat with a first message (used by Handoff and the side chat).
    Returns the chat's key once Hermes has registered it."""
    text = message(p)
    # No title: Hermes treats a title as the chat's identity and would REUSE an existing chat with the same title
    # (session.create resolves titled sessions, like `chat -c <title>`). Hermes names the new chat itself.
    # A folder you picked on the board becomes the chat's workspace (a deliberate pick, as in the Hermes app).
    folder = str(p.get('cwd') or '')
    created = await rpc(client, 'session.create', **({'cwd': folder, 'cwd_explicit': True} if folder else {}))
    sid = created['session_id']
    try:
        await attach_images(client, sid, p.get('images'))
        await rpc(client, 'prompt.submit', session_id=sid, text=text,
                  submission_id=f'agenthub-{uuid.uuid4()}', queued=True)
        key = None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 30
        while key is None and loop.time() < deadline:
            rows = (await rpc(client, 'session.active_list')).get('sessions', [])
            key = next((r.get('session_key') for r in rows if r.get('id') == sid and r.get('session_key')), None)
            if key is None:
                await asyncio.sleep(1)
        return {'session_id': sid, 'session_key': key}
    finally:
        sub = created.get('subscription_id')
        if sub:
            with contextlib.suppress(Exception):  # a viewer leaving; the new chat keeps running
                await rpc(client, 'session.detach', session_id=sid, subscription_id=sub)


async def cmd_delete(client, p):
    """Permanently delete one Hermes chat. Only run after the user named exactly which chats."""
    key = str(p.get('key') or '')
    if not key:
        raise BridgeError('no session key given')
    info = await rpc(client, 'session.info', session_id=key)
    revision = info.get('runtime_revision', info.get('revision'))
    await rpc(client, 'session.mutate', session_id=key, request_id=f'agenthub-{uuid.uuid4()}',
              expected_revision=revision, operation='delete', payload={})
    return {'deleted': key}


COMMANDS = {'live': cmd_live, 'reply': cmd_reply, 'approve': cmd_approve, 'clarify': cmd_clarify, 'changes': cmd_changes,
            'btw': cmd_btw, 'side': cmd_side, 'slash': cmd_slash, 'end': cmd_end, 'commands': cmd_commands, 'create': cmd_create,
            'delete': cmd_delete}


async def main(cmd, params):
    from hermes_cli.gateway_client import connect_gateway, outside_restart_wait
    ep = endpoint()
    if cmd == 'live':
        # A background poll must never hold up a Hermes restart.
        with outside_restart_wait():
            async with connect_gateway(ep) as client:
                return await cmd_live(client, params)
    async with connect_gateway(ep) as client:
        return await COMMANDS[cmd](client, params)


if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    if command not in COMMANDS:
        print(json.dumps({'ok': False, 'error': f'unknown command {command!r}'}))
        sys.exit(2)
    try:
        raw = sys.stdin.read() if command not in ('live', 'commands') else ''
        result = asyncio.run(main(command, json.loads(raw) if raw.strip() else {}))
        print(json.dumps({'ok': True, **result}, default=str))
    # Handled failures still exit 0: the JSON answer on stdout is the result the board reads.
    except BridgeError as e:
        print(json.dumps({'ok': False, 'error': str(e)}))
    except Exception as e:  # transport loss, discovery failure: report, never guess
        print(json.dumps({'ok': False, 'error': f'{type(e).__name__}: {e}'}))
