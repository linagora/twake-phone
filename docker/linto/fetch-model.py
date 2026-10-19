"""The model of LinTO STT for the development and CI stack (step 11b, ADR 0023), checked against its SHA-256.

    fetch-model.py --into DIR NAME SHA256   puts NAME.zip into DIR (the cache of the build), unless it is there and
                                            the right one: what the CI keeps between runs (actions/cache).
    fetch-model.py --install DIR NAME SHA256
                                            in the image build: unpacks NAME.zip to /opt/model, taken from DIR (the
                                            cache, mounted for that step only) when it is there and the right one,
                                            else downloaded. The archive is never left in a layer of the image.

Any other file than the one of that SHA-256 stops it. The SHA-256 is that of the archive the project downloaded first
(trust on first use: its publisher gives none), the same since on every CI runner (docker/README.md).
"""

import hashlib
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile

URL = 'https://alphacephei.com/vosk/models/{name}.zip'


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def download(name, expected, into):
    """NAME.zip downloaded to a file of `into`, checked: its path. Interrupted or not the model: no file left."""
    fd, path = tempfile.mkstemp(suffix='.zip', dir=into)
    try:
        with os.fdopen(fd, 'wb') as out, urllib.request.urlopen(URL.format(name=name), timeout=300) as res:
            shutil.copyfileobj(res, out)
        got = digest(path)
    except BaseException:
        os.remove(path)
        raise
    if got != expected:
        os.remove(path)
        sys.exit(f'{name}.zip: sha256 {got}, not the expected model ({expected})')
    print(f'{name}.zip sha256 {got} (downloaded)')
    return path


def main(argv):
    if len(argv) != 5 or argv[1] not in ('--into', '--install'):
        sys.exit(__doc__)
    mode, cache, name, expected = argv[1:]
    cached = os.path.join(cache, f'{name}.zip')
    good = os.path.isfile(cached) and digest(cached) == expected
    if mode == '--into':
        os.makedirs(cache, exist_ok=True)
        if good:
            print(f'{name}.zip sha256 {expected} (cached)')
            return
        os.replace(download(name, expected, cache), cached)
        return
    if good:
        print(f'{name}.zip sha256 {expected} (cached)')
        archive = cached
    else:
        archive = download(name, expected, tempfile.gettempdir())
    with zipfile.ZipFile(archive) as z:
        z.extractall('/opt')
    shutil.move(f'/opt/{name}', '/opt/model')
    if archive != cached:
        os.remove(archive)


if __name__ == '__main__':
    main(sys.argv)
