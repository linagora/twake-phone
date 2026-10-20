"""The recordings server of the development and CI stack (step 11d, ADR 0029).

On a Wazo, the recordings of a call are files that Asterisk's MixMonitor writes, `<dir>/<tenant>/monitor/<uuid>.wav`
(/var/lib/wazo/sounds/tenants), and wazo-call-logd serves them by the identifier of a CDR that this architecture does not
make. This stands in for what the Gateway needs, and a deployment can run it on the machine of Wazo (or serve the same
folder with the same contract behind its nginx):

    GET    /<tenant>/<uuid>   the file (audio/wav), `Content-Length` said, 404 when there is none (the length it had when the
                              request came: a file still being written is read up to it)
    HEAD   /<tenant>/<uuid>   the same without the body
    DELETE /<tenant>/<uuid>   erases it: 204, 404 when there was none
    HEAD   /sound/<name>      200 when Asterisk has that sound (`custom/twake-recording-notice`: RECORDINGS_SOUNDS, its sounds
                              directories, no language), else 404: no recording is started without its notice

Every request carries `Authorization: Bearer <RECORDINGS_TOKEN>` (32 characters at least): without it, 401, whatever is asked.
A tenant is a name (letters, digits, `_`, `-`), a recording a UUID in lower case: any other path is 404. Only a regular
file inside the folder is read or erased (never a link, never a path that leaves it). The browser's requests are refused
(Origin, Sec-Fetch-Site) as wazo-sysconfd's stand-in does, and so is a `Host` that is neither the loopback nor the address it
listens on (RECORDINGS_LISTEN: reached by a name, put that name's address there or behind a proxy that sets `Host`). It listens
where RECORDINGS_LISTEN says (127.0.0.1:8670): the loopback, and it runs as root on the stack, because the files are Asterisk's
and erasing one means writing in its folder.

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
SOUNDS = [d for d in os.environ.get('RECORDINGS_SOUNDS', '/usr/share/asterisk/sounds:/var/lib/asterisk/sounds').split(':') if d]
SOUND_EXTENSIONS = ('wav', 'sln', 'sln16', 'sln48', 'gsm', 'ulaw', 'alaw', 'g722', 'g729', 'ogg', 'mp3')
SOUND = re.compile(r'^/sound/([A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*)$')
PATH = re.compile(r'^/([A-Za-z0-9_-]{1,64})/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')
CHUNK = 64 * 1024


def log(message):
    print(message, file=sys.stderr, flush=True)


def has_sound(path):
    """Whether Asterisk has the sound a path names: a file of a known format in one of its sounds directories."""
    m = SOUND.match(path)
    return bool(m) and any(os.path.isfile(os.path.join(d, f'{m.group(1)}.{ext}')) for d in SOUNDS for ext in SOUND_EXTENSIONS)


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
        route = self.path.split('?', 1)[0]
        if route.startswith('/sound/'):
            if method != 'HEAD':
                return self._send(405)
            return self._send(200 if has_sound(route) else 404, head=True)
        found = locate(route)
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
        headers = {'Content-Type': 'audio/wav', 'Content-Length': str(size)}
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
            # No more than the length said: a file still written grows past it.
            left = size
            while left > 0:
                chunk = f.read(min(CHUNK, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

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
