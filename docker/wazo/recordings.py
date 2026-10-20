"""The recordings server of the development and CI stack (step 11d, ADR 0029).

On a Wazo, the recordings of a call are files that Asterisk's MixMonitor writes, `<dir>/<tenant>/monitor/<uuid>.wav`
(/var/lib/wazo/sounds/tenants), and wazo-call-logd serves them by the identifier of a CDR that this architecture does not
make. This stands in for what the Gateway needs, and a deployment can run it on the machine of Wazo (or serve the same
folder with the same contract behind its nginx):

    GET    /<tenant>/<uuid>   the file (audio/wav), `Content-Length` and `Accept-Ranges` said, 404 when there is none
    HEAD   /<tenant>/<uuid>   the same without the body
    DELETE /<tenant>/<uuid>   erases it: 204, 404 when there was none

Every request carries `Authorization: Bearer <RECORDINGS_TOKEN>` (32 characters at least): without it, 401, whatever is asked.
A tenant is a name (letters, digits, `_`, `-`), a recording a UUID in lower case: any other path is 404. Only a regular
file inside the folder is read or erased (never a link, never a path that leaves it). The browser's requests are refused
(Origin, Sec-Fetch-Site) as wazo-sysconfd's stand-in does. It listens where RECORDINGS_LISTEN says (127.0.0.1:8670): the
loopback, and it runs as root on the stack, because the files are Asterisk's and erasing one means writing in its folder.

Standard library only: it runs with the Python of a Wazo image.
"""

import hmac
import os
import re
import stat
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN = os.environ.get('RECORDINGS_LISTEN', '127.0.0.1:8670')
ROOT = os.path.realpath(os.environ.get('RECORDINGS_DIR', '/var/lib/wazo/sounds/tenants'))
TOKEN = os.environ.get('RECORDINGS_TOKEN', '')
PATH = re.compile(r'^/([A-Za-z0-9_-]{1,64})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')
CHUNK = 64 * 1024


def log(message):
    print(message, file=sys.stderr, flush=True)


def locate(path):
    """The file a path names, or None: a regular file inside ROOT, the very place MixMonitor wrote it."""
    m = PATH.match(path)
    if not m:
        return None
    candidate = os.path.join(ROOT, m.group(1), 'monitor', m.group(2) + '.wav')
    try:
        info = os.lstat(candidate)
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode) or os.path.commonpath([ROOT, os.path.realpath(candidate)]) != ROOT:
        return None
    return candidate, info.st_size


class Handler(BaseHTTPRequestHandler):
    server_version = 'recordings'
    sys_version = ''

    def log_message(self, fmt, *args):
        pass

    def _refuse(self):
        host = self.headers.get('Host', '')
        # A web page of this machine reaches the loopback too: its Origin, or a name that is not the address we listen on.
        return (
            self.headers.get('Origin') is not None
            or self.headers.get('Sec-Fetch-Site') is not None
            or host.rsplit(':', 1)[0] not in ('127.0.0.1', 'localhost', '[::1]', LISTEN.rsplit(':', 1)[0])
        )

    def _send(self, status, body=b'', headers=None, head=False):
        self.send_response(status)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if 'Content-Length' not in (headers or {}):
            self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'private, no-store')
        self.end_headers()
        if body and not head:
            self.wfile.write(body)

    def _authorised(self):
        given = self.headers.get('Authorization', '')
        return len(TOKEN) >= 32 and given.startswith('Bearer ') and hmac.compare_digest(given[7:].encode(), TOKEN.encode())

    def _serve(self, method):
        if self._refuse():
            return self._send(403)
        if not self._authorised():
            return self._send(401, headers={'WWW-Authenticate': 'Bearer'})
        found = locate(self.path.split('?', 1)[0])
        if not found:
            return self._send(404)
        path, size = found
        if method == 'DELETE':
            try:
                os.unlink(path)
            except FileNotFoundError:
                return self._send(404)
            log('recording erased')
            return self._send(204)
        headers = {'Content-Type': 'audio/wav', 'Content-Length': str(size), 'Accept-Ranges': 'bytes'}
        if method == 'HEAD':
            return self._send(200, headers=headers, head=True)
        try:
            f = open(path, 'rb')
        except OSError:
            return self._send(404)
        with f:
            self.send_response(200)
            for k, v in headers.items():
                self.send_header(k, v)
            self.send_header('Cache-Control', 'private, no-store')
            self.end_headers()
            while True:
                chunk = f.read(CHUNK)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def do_GET(self):
        self._serve('GET')

    def do_HEAD(self):
        self._serve('HEAD')

    def do_DELETE(self):
        self._serve('DELETE')

    def do_POST(self):
        self._send(405)

    do_PUT = do_PATCH = do_POST


def main():
    if len(TOKEN) < 32:
        sys.exit('RECORDINGS_TOKEN must be 32 characters at least')
    host, port = LISTEN.rsplit(':', 1)
    ThreadingHTTPServer((host, int(port)), Handler).serve_forever()


if __name__ == '__main__':
    main()
