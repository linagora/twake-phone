"""Healthcheck of a Wazo service of the development and CI stack (ADR 0022).

  healthcheck.py http://127.0.0.1:9497/0.1/backends up when it answers HTTP at all (401 included: it asks a token)
  healthcheck.py tcp:127.0.0.1:8669                up when it takes a connection
"""

import socket
import sys
import urllib.error
import urllib.request

target = sys.argv[1]
try:
    if target.startswith('tcp:'):
        host, port = target[4:].rsplit(':', 1)
        socket.create_connection((host, int(port)), timeout=2).close()
    else:
        try:
            urllib.request.urlopen(target, timeout=2).close()
        except urllib.error.HTTPError:
            pass
except OSError as err:
    sys.exit(f'{target}: {err}')
