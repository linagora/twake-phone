"""What wazo-confd asks of wazo-sysconfd, for the development and CI stack (ADR 0022).

On a Wazo, wazo-sysconfd (root, the machine's own configuration) runs the Asterisk commands that apply a change made
through wazo-confd and removes a deleted mailbox's spool; it has no image (it manages the host). This stands in for the
part wazo-confd uses with voicemails: POST /exec_request_handlers (its `ipbx` commands, those of a known list, through
Asterisk's AMI), GET /delete_voicemail and GET /move_voicemail (the mailbox's directory in the spool), GET /status-check.
Anything else is answered 200 and written to the log, as nothing of it applies here.

wazo-confd's requests carry no credentials (as with Wazo's own wazo-sysconfd, on the loopback): a browser's are refused
(review 11a, n°22), those that say where they come from (Origin, Sec-Fetch-Site) or name another host than the one it
listens on (a DNS name made to point to the loopback), so that no web page opened on this machine deletes a mailbox.
An Asterisk command is answered once Asterisk answered it (its ActionID), and fails when Asterisk refused it.

Standard library only: it runs with the Python of a Wazo image, on the loopback.
"""

import json
import os
import re
import shutil
import socket
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

LISTEN = os.environ.get('SYSCONFD_LISTEN', '127.0.0.1:8668')
AMI = os.environ.get('SYSCONFD_AMI', '127.0.0.1:5038')
AMI_USER = os.environ.get('SYSCONFD_AMI_USER', 'wazo_amid')
AMI_PASSWORD = os.environ['SYSCONFD_AMI_PASSWORD']
SPOOL = '/var/spool/asterisk/voicemail'
# The commands wazo-confd sends after a change to voicemails, users and lines.
COMMANDS = {'voicemail reload', 'module reload res_pjsip.so', 'module reload chan_sccp.so', 'dialplan reload', 'module reload app_queue.so', 'module reload features'}
NAME = re.compile(r'^[A-Za-z0-9_-]{1,79}$')
# The Host of wazo-confd's requests: the address it was given (its configuration's sysconfd host and port).
ALLOWED_HOSTS = {LISTEN.lower(), f'localhost:{LISTEN.rsplit(":", 1)[1]}'}
NUMBER = re.compile(r'^[0-9]{1,40}$')


def log(message):
    print(f'sysconfd: {message}', file=sys.stderr, flush=True)


class AmiError(Exception):
    pass


def ami_command(command):
    """Runs an Asterisk command through the AMI: its answer, once Asterisk gave it (the block of its ActionID, the
    events before it, FullyBooted among them, left aside); AmiError when Asterisk refused it."""
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
        login = uuid.uuid4().hex
        send(['Action: Login', f'ActionID: {login}', f'Username: {AMI_USER}', f'Secret: {AMI_PASSWORD}'])
        if 'Response: Success' not in answer_of(login):
            raise PermissionError('AMI refused the login')
        action = uuid.uuid4().hex
        send(['Action: Command', f'ActionID: {action}', f'Command: {command}'])
        answer = answer_of(action)
        send(['Action: Logoff'])
        if 'Response: Error' in answer:
            message = next((line[len('Message: '):] for line in answer if line.startswith('Message: ')), 'refused')
            raise AmiError(f'Asterisk refused {command!r}: {message}')
        return answer


def mailbox_dir(context, mailbox):
    if not NAME.match(context or '') or not NUMBER.match(mailbox or ''):
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
            shutil.rmtree(path, ignore_errors=True)
            log(f'mailbox {q["mailbox"]}@{q["context"]} removed from the spool')
            return self.answer()
        if url.path == '/move_voicemail':
            old = mailbox_dir(q.get('old_context'), q.get('old_mailbox'))
            new = mailbox_dir(q.get('new_context'), q.get('new_mailbox'))
            if not old or not new:
                return self.answer(400, {'error': 'invalid mailbox'})
            if os.path.isdir(old) and not os.path.exists(new):
                os.makedirs(os.path.dirname(new), exist_ok=True)
                shutil.move(old, new)
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
            for command in body.get('ipbx', []):
                if command not in COMMANDS:
                    log(f'ipbx command not run: {command!r}')
                    continue
                try:
                    ami_command(command)
                    log(f'ran {command!r}')
                except (OSError, PermissionError, AmiError) as err:
                    log(f'{command!r} failed: {err}')
                    return self.answer(500, {'error': str(err)})
            return self.answer()
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
