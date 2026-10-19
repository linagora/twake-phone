"""What wazo-confd asks of wazo-sysconfd, for the development and CI stack (ADR 0022).

On a Wazo, wazo-sysconfd (root, the machine's own configuration) runs the Asterisk commands that apply a change made
through wazo-confd and removes a deleted mailbox's spool; it has no image (it manages the host). This stands in for the
part wazo-confd uses with voicemails: POST /exec_request_handlers (its `ipbx` commands, those of a known list, through
Asterisk's AMI), GET /delete_voicemail and GET /move_voicemail (the mailbox's directory in the spool), GET /status-check.
Anything else is answered 200 and written to the log, as nothing of it applies here.

wazo-confd's requests carry no credentials (as with Wazo's own wazo-sysconfd, on the loopback): a browser's are refused
, those that say where they come from (Origin, Sec-Fetch-Site) or name another host than the one it
listens on (a DNS name made to point to the loopback), so that no web page opened on this machine deletes a mailbox.
An Asterisk command is done once Asterisk answered it (its ActionID), and fails (in the log; 500 when synchronous) when Asterisk refused it. It logs
in with an AMI account of its own and no event, and runs each command as the AMI action
that does it, never through the CLI: the module reloads (Reload, the `system` privilege) and
the list of the mailboxes (VoicemailUsersList, `reporting`). The account (`write = system,reporting`:
docker/wazo/asterisk/entrypoint.sh) is refused `Command`, `Originate` and `UpdateConfig`, but `system` lets it do more
than this needs: read any configuration file (GetConfig, GetConfigJSON, the manager's
included), load a module (ModuleLoad), hang up a channel (Hangup, AbsoluteTimeout), add or remove a dialplan extension
(DialplanExtensionAdd and DialplanExtensionRemove). Asterisk has no finer privilege for Reload: the account and its
password exist on the development and CI stack only, on the loopback, for this stand-in; a real Wazo's wazo-sysconfd
runs its commands with `asterisk -rx` on its own machine, and no TwakePhone account is made in its AMI. The e2e
proves against this stack's Asterisk what the account is refused and what it is let do. `voicemail reload` fails as
well when Asterisk does not have, after it, every mailbox wazo-confgend gave before it (a reload that could not read
its configuration still says Success).

The mailboxes' directories, as wazo-sysconfd itself does it (its source, wazo_sysconfd/plugins/asterisk/asterisk.py):
a mailbox deleted loses its folder (rmtree); a mailbox moved (wazo-confd asks it only when
its number or context changed, after its database committed) replaces whatever is under the target (rm -rf, then mv),
and nothing when it had no folder. No quarantine: the Gateway never changes a mailbox's number (a person's mailbox
keeps its number whatever extension they hold, provider-wazo), so nothing here moves on a real Wazo either.

Its queue is wazo-sysconfd's own (wazo_sysconfd/plugins/request_handlers/request.py): a request is answered 200 at once
and its commands run one after another in one worker; a command that is already waiting in the queue (not yet taken by
the worker) is not queued twice, its request ends when the one waiting has run. So a burst of requests costs one
reload of a module while a first one runs, and one more for all those that came meanwhile, never one each. wazo-confd
sends the commands of one HTTP request together (a set) and nothing across two requests: only this queue merges
requests. wazo-sysconfd's `request_handlers.synchronous` (false by default) is SYSCONFD_SYNCHRONOUS=1: the answer waits
for the request to have run, and, which wazo-sysconfd never does, says 500 when a command failed (the tests of this
stand-in use it).

Standard library only: it runs with the Python of a Wazo image, on the loopback.
"""

import json
import os
import re
import shutil
import socket
import sys
import threading
import uuid
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

LISTEN = os.environ.get('SYSCONFD_LISTEN', '127.0.0.1:8668')
AMI = os.environ.get('SYSCONFD_AMI', '127.0.0.1:5038')
AMI_USER = os.environ.get('SYSCONFD_AMI_USER', 'twake_sysconfd')
AMI_PASSWORD = os.environ['SYSCONFD_AMI_PASSWORD']
CONFGEND = os.environ.get('SYSCONFD_CONFGEND', '127.0.0.1:8669')
SYNCHRONOUS = os.environ.get('SYSCONFD_SYNCHRONOUS') == '1'
SPOOL = os.environ.get('SYSCONFD_SPOOL', '/var/spool/asterisk/voicemail')
# The commands wazo-confd sends after a change to voicemails, users and lines, each the module the AMI reloads for it.
RELOADS = {
    'voicemail reload': 'app_voicemail.so',
    'module reload res_pjsip.so': 'res_pjsip.so',
    'module reload chan_sccp.so': 'chan_sccp.so',
    'dialplan reload': 'pbx_config.so',
    'module reload app_queue.so': 'app_queue.so',
    'module reload features': 'features',
}
COMMANDS = set(RELOADS)
# Modules a Wazo may not load (SCCP phones): not there, nothing to reload, as the CLI says it.
OPTIONAL = {'chan_sccp.so'}
# Matched whole (fullmatch: `$` would take a final newline).
NAME = re.compile(r'[A-Za-z0-9_-]{1,79}')
# The Host of wazo-confd's requests: the address it was given (its configuration's sysconfd host and port).
ALLOWED_HOSTS = {LISTEN.lower(), f'localhost:{LISTEN.rsplit(":", 1)[1]}'}
NUMBER = re.compile(r'[0-9]{1,40}')


def log(message):
    print(f'sysconfd: {message}', file=sys.stderr, flush=True)


class AmiError(Exception):
    pass


def confgend(name):
    """A configuration file as wazo-confgend makes it (as wazo-confgen asks it: the name, the file in the answer)."""
    host, port = CONFGEND.rsplit(':', 1)
    with socket.create_connection((host, int(port)), timeout=10) as s:
        s.sendall(name.encode())
        chunks = []
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    return b''.join(chunks).decode(errors='replace')


def mailboxes_of(conf):
    """The mailboxes of a voicemail.conf, as {(context, number)}: the lines `number => ...` of every section but
    [general] and [zonemessages]."""
    found = set()
    section = None
    for line in conf.splitlines():
        line = line.strip()
        if line.startswith('[') and line.endswith(']'):
            section = line[1:-1]
            continue
        if section in (None, 'general', 'zonemessages') or '=>' not in line:
            continue
        number = line.split('=>', 1)[0].strip()
        if NUMBER.fullmatch(number):
            found.add((section, number))
    return found


def mailboxes_listed(entries):
    """The mailboxes the AMI's VoicemailUsersList listed (its VoicemailUserEntry events), as {(context, number)}."""
    found = set()
    for entry in entries:
        context, number = entry.get('VMContext', ''), entry.get('VoiceMailbox', '')
        if NAME.fullmatch(context) and NUMBER.fullmatch(number):
            found.add((context, number))
    return found


def fields(block):
    """An AMI block as {key: value}."""
    return dict(line.split(': ', 1) for line in block if ': ' in line)


def ami_actions(actions):
    """Runs AMI actions, in one session, with no event (Events: off): the answer of each, once Asterisk answered it
    (the block of its ActionID; for a list, its entries too, until its EventList completes); AmiError when Asterisk
    refused one (the next ones not run), unless it is a reload of an OPTIONAL module that is not there."""
    host, port = AMI.rsplit(':', 1)
    with socket.create_connection((host, int(port)), timeout=10) as s:
        f = s.makefile('rwb')
        f.readline()  # the banner
        def send(lines):
            f.write(('\r\n'.join(lines) + '\r\n\r\n').encode())
            f.flush()
        def read():
            block = []
            while True:
                line = f.readline()
                if not line:
                    raise ConnectionError('AMI closed the connection')
                line = line.decode(errors='replace').rstrip('\r\n')
                if line == '':
                    if block:
                        return block
                    continue
                block.append(line)
        def answer_of(action_id):
            # At most 200 blocks (events) before the answer: an AMI that never answers is an error, not a wait.
            for _ in range(200):
                block = read()
                if f'ActionID: {action_id}' in block and any(line.startswith('Response: ') for line in block):
                    return block
            raise AmiError('no answer from the AMI')
        def entries_of(action_id):
            # The entries of a list, its own (its ActionID), until it says it is complete: 100000 at most.
            entries = []
            for _ in range(100_000):
                block = fields(read())
                if block.get('ActionID') != action_id:
                    continue
                if block.get('EventList') == 'Complete':
                    return entries
                entries.append(block)
            raise AmiError('a list of the AMI that never ends')
        login = uuid.uuid4().hex
        send(['Action: Login', f'ActionID: {login}', f'Username: {AMI_USER}', f'Secret: {AMI_PASSWORD}', 'Events: off'])
        if 'Response: Success' not in answer_of(login):
            raise PermissionError('AMI refused the login')
        answers = []
        for lines in actions:
            action = uuid.uuid4().hex
            send(lines + [f'ActionID: {action}'])
            answer = fields(answer_of(action))
            name = lines[0].split(': ', 1)[1]
            if answer.get('Response') == 'Error':
                message = answer.get('Message', 'refused')
                module = next((line.split(': ', 1)[1] for line in lines if line.startswith('Module: ')), None)
                if name == 'Reload' and module in OPTIONAL and message == 'No such module':
                    answers.append(answer)
                    continue
                raise AmiError(f'Asterisk refused {name} {module or ""}: {message}'.replace('  ', ' '))
            if answer.get('EventList') == 'start':
                answer['entries'] = entries_of(action)
            answers.append(answer)
        send(['Action: Logoff'])
        return answers


def reload_action(module):
    return ['Action: Reload', f'Module: {module}']


def ami_command(command):
    """Runs one of the COMMANDS, as the AMI reload of its module: `voicemail reload` checked by the mailboxes Asterisk
    lists after it (every mailbox wazo-confgend gave before it is there), AmiError otherwise."""
    if command != 'voicemail reload':
        return ami_actions([reload_action(RELOADS[command])])[0]
    try:
        expected = mailboxes_of(confgend('asterisk/voicemail.conf'))
    except OSError as err:
        raise AmiError(f'wazo-confgend not reached, voicemail reload not run: {err}') from err
    reloaded, listed = ami_actions([reload_action(RELOADS[command]), ['Action: VoicemailUsersList']])
    missing = expected - mailboxes_listed(listed.get('entries', []))
    if missing:
        raise AmiError(f'voicemail reload: {len(missing)} mailbox(es) of wazo-confgend not in Asterisk after it, as {", ".join(sorted(f"{n}@{c}" for c, n in missing)[:5])}')
    return reloaded


class Command:
    def __init__(self, value):
        self.value = value
        self.optimized = False


class Request:
    def __init__(self, commands):
        self.id = str(uuid.uuid4())
        self.commands = commands
        self.error = None
        self.done = threading.Event()

    def run(self):
        for command in self.commands:
            if command.optimized:
                log(f'{command.value!r} merged into the one waiting')
                continue
            try:
                ami_command(command.value)
                log(f'ran {command.value!r}')
            except (OSError, PermissionError, AmiError) as err:
                log(f'{command.value!r} failed: {err}')
                self.error = err
                break  # the next ones are not run
        self.done.set()


class RequestQueue:
    """wazo-sysconfd's RequestQueue with its DuplicateRequestOptimizer: `waiting` holds the first command of each
    value until the worker takes its request; a command of a value in it is marked optimized and does not run."""

    def __init__(self):
        self.condition = threading.Condition()
        self.queue = deque()
        self.waiting = set()

    def put(self, request):
        with self.condition:
            for command in request.commands:
                if command.value in self.waiting:
                    command.optimized = True
                else:
                    self.waiting.add(command.value)
            self.queue.append(request)
            self.condition.notify()

    def get(self):
        with self.condition:
            while not self.queue:
                self.condition.wait()
            request = self.queue.popleft()
            for command in request.commands:
                if not command.optimized:
                    self.waiting.discard(command.value)
            return request


QUEUE = RequestQueue()


def work():
    while True:
        QUEUE.get().run()


threading.Thread(target=work, daemon=True).start()


def mailbox_dir(context, mailbox):
    if not NAME.fullmatch(context or '') or not NUMBER.fullmatch(mailbox or ''):
        return None
    return os.path.join(SPOOL, context, mailbox)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log(fmt % args)

    def answer(self, status=200, body=None):
        raw = json.dumps(body if body is not None else {}).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def from_a_browser(self):
        """A request a web page made (or one for another host): refused, 403."""
        host = (self.headers.get('Host') or '').strip().lower()
        if self.headers.get('Origin') is not None or self.headers.get('Sec-Fetch-Site') is not None or self.headers.get('Sec-Fetch-Mode') is not None or host not in ALLOWED_HOSTS:
            log(f'{self.command} {urlparse(self.path).path} refused: not from wazo-confd (Origin, Sec-Fetch-*, Host {host!r})')
            self.answer(403, {'error': 'forbidden'})
            return True
        return False

    def do_GET(self):
        if self.from_a_browser():
            return
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == '/status-check':
            return self.answer(200, {'status': 'ok'})
        if url.path == '/delete_voicemail':
            path = mailbox_dir(q.get('context'), q.get('mailbox'))
            if not path:
                return self.answer(400, {'error': 'invalid mailbox'})
            if os.path.exists(path):
                shutil.rmtree(path)
            log(f'mailbox {q["mailbox"]}@{q["context"]} removed from the spool')
            return self.answer()
        if url.path == '/move_voicemail':
            old = mailbox_dir(q.get('old_context'), q.get('old_mailbox'))
            new = mailbox_dir(q.get('new_context'), q.get('new_mailbox'))
            if not old or not new:
                return self.answer(400, {'error': 'invalid mailbox'})
            # As wazo-sysconfd: nothing without a folder at the old number; else the target replaced, whatever it held.
            if old == new or not os.path.exists(old):
                return self.answer()
            shutil.rmtree(new, ignore_errors=True)
            os.makedirs(os.path.dirname(new), exist_ok=True)
            os.rename(old, new)
            log(f'mailbox {q["old_mailbox"]}@{q["old_context"]} moved to {q["new_mailbox"]}@{q["new_context"]}')
            return self.answer()
        log(f'GET {url.path}: nothing to do here')
        return self.answer()

    def do_POST(self):
        if self.from_a_browser():
            return
        length = int(self.headers.get('Content-Length') or 0)
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            return self.answer(400, {'error': 'invalid JSON'})
        if self.path == '/exec_request_handlers':
            commands = []
            for command in body.get('ipbx', []):
                if command in COMMANDS:
                    commands.append(Command(command))
                else:
                    log(f'ipbx command not run: {command!r}')
            request = Request(commands)
            QUEUE.put(request)
            # As wazo-sysconfd's SyncRequestHandlers: it waits 30 s for the request to have run.
            if SYNCHRONOUS and not request.done.wait(30):
                return self.answer(500, {'error': 'timeout reached on synchronous request'})
            if SYNCHRONOUS and request.error:
                return self.answer(500, {'error': str(request.error)})
            return self.answer(200, {'request_uuid': request.id})
        log(f'POST {self.path}: nothing to do here')
        return self.answer()

    def do_DELETE(self):
        if self.from_a_browser():
            return
        log(f'DELETE {self.path}: nothing to do here')
        return self.answer()


if __name__ == '__main__':
    host, port = LISTEN.rsplit(':', 1)
    ThreadingHTTPServer((host, int(port)), Handler).serve_forever()
