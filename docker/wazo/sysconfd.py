"""What wazo-confd asks of wazo-sysconfd, for the development and CI stack (ADR 0021).

On a Wazo, wazo-sysconfd (root, the machine's own configuration) runs the Asterisk commands that apply a change made
through wazo-confd and removes a deleted mailbox's spool; it has no image (it manages the host). This stands in for the
part wazo-confd uses with voicemails: POST /exec_request_handlers (its `ipbx` commands, those of a known list, through
Asterisk's AMI), GET /delete_voicemail and GET /move_voicemail (the mailbox's directory in the spool), GET /status-check.
Anything else is answered 200 and written to the log, as nothing of it applies here.

Standard library only: it runs with the Python of a Wazo image, on the loopback.
"""

import json
import os
import re
import shutil
import socket
import sys
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
NUMBER = re.compile(r'^[0-9]{1,40}$')


def log(message):
    print(f'sysconfd: {message}', file=sys.stderr, flush=True)


def ami_command(command):
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
                    return block
                block.append(line)
        send(['Action: Login', f'Username: {AMI_USER}', f'Secret: {AMI_PASSWORD}'])
        if 'Response: Success' not in read():
            raise PermissionError('AMI refused the login')
        send(['Action: Command', f'Command: {command}'])
        answer = read()
        send(['Action: Logoff'])
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

    def do_GET(self):
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
                except (OSError, PermissionError) as err:
                    log(f'{command!r} failed: {err}')
                    return self.answer(500, {'error': str(err)})
            return self.answer()
        log(f'POST {self.path}: nothing to do here')
        return self.answer()

    def do_DELETE(self):
        log(f'DELETE {self.path}: nothing to do here')
        return self.answer()


if __name__ == '__main__':
    host, port = LISTEN.rsplit(':', 1)
    ThreadingHTTPServer((host, int(port)), Handler).serve_forever()
