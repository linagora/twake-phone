"""docker/wazo/recordings.py: the recordings server of the stack, as the Gateway reaches it (step 11d, ADR 0029).

    python3 -I -m unittest discover -s docker/wazo/tests
"""
import http.client
import importlib.util
import os
import shutil
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = tempfile.mkdtemp()
TOKEN = 'a' * 40
SOUNDS = tempfile.mkdtemp()
os.environ.update({'RECORDINGS_DIR': ROOT, 'RECORDINGS_TOKEN': TOKEN, 'RECORDINGS_LISTEN': '127.0.0.1:0', 'RECORDINGS_SOUNDS': SOUNDS})
spec = importlib.util.spec_from_file_location('recordings', os.path.join(HERE, '..', 'recordings.py'))
recordings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recordings)
recordings.log = lambda message: None

NAME = '3f2b8c0e-4d1a-4b7e-9c55-0a1b2c3d4e5f'
OTHER = '3f2b8c0e-4d1a-4b7e-9c55-0a1b2c3d4e60'
AUDIO = b'RIFF' + bytes(range(256)) * 600


class RecordingsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), recordings.Handler)
        cls.port = cls.server.server_address[1]
        recordings.LISTEN = f'127.0.0.1:{cls.port}'
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        shutil.rmtree(ROOT, ignore_errors=True)
        shutil.rmtree(SOUNDS, ignore_errors=True)

    def setUp(self):
        os.makedirs(os.path.join(ROOT, 'acme', 'monitor'), exist_ok=True)
        with open(os.path.join(ROOT, 'acme', 'monitor', NAME + '.wav'), 'wb') as f:
            f.write(AUDIO)

    def request(self, method, path, token=TOKEN, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port)
        h = dict(headers or {})
        if token is not None:
            h['Authorization'] = f'Bearer {token}'
        conn.request(method, path, headers=h)
        res = conn.getresponse()
        body = res.read()
        conn.close()
        return res, body

    def test_gives_the_file_and_says_its_length(self):
        res, body = self.request('GET', f'/acme/{NAME}')
        self.assertEqual(res.status, 200)
        self.assertEqual(body, AUDIO)
        self.assertEqual(res.getheader('Content-Type'), 'audio/wav')
        self.assertEqual(res.getheader('Content-Length'), str(len(AUDIO)))
        self.assertEqual(res.getheader('Cache-Control'), 'private, no-store')
        res, body = self.request('HEAD', f'/acme/{NAME}')
        self.assertEqual((res.status, body, res.getheader('Content-Length')), (200, b'', str(len(AUDIO))))

    def test_asks_the_token_before_anything_else(self):
        for token in (None, 'b' * 40, TOKEN[:-1], ''):
            for path in (f'/acme/{NAME}', f'/acme/{OTHER}', '/x'):
                res, _ = self.request('GET', path, token)
                self.assertEqual(res.status, 401, (token, path))
        res, _ = self.request('DELETE', f'/acme/{NAME}', None)
        self.assertEqual(res.status, 401)
        self.assertTrue(os.path.exists(os.path.join(ROOT, 'acme', 'monitor', NAME + '.wav')))

    def test_refuses_a_browser_and_a_host_that_is_not_ours(self):
        for headers in ({'Origin': 'https://evil.example'}, {'Sec-Fetch-Site': 'cross-site'}, {'Host': 'evil.example'}):
            res, _ = self.request('GET', f'/acme/{NAME}', headers=headers)
            self.assertEqual(res.status, 403, headers)

    def test_names_nothing_that_is_not_a_tenant_and_a_recording(self):
        for path in ('/', '/acme', f'/acme/{NAME}.wav', f'/ac%20me/{NAME}', f'/../{NAME}', '/acme/../acme/' + NAME, f'/acme/{NAME.upper()}', f'/acme/{OTHER}', f'/other/{NAME}', f'/acme/monitor/{NAME}'):
            res, _ = self.request('GET', path)
            self.assertEqual(res.status, 404, path)

    def test_never_follows_a_link_out_of_the_folder(self):
        outside = tempfile.NamedTemporaryFile(delete=False)
        outside.write(b'secret')
        outside.close()
        try:
            os.symlink(outside.name, os.path.join(ROOT, 'acme', 'monitor', OTHER + '.wav'))
            for method in ('GET', 'HEAD', 'DELETE'):
                res, body = self.request(method, f'/acme/{OTHER}')
                self.assertEqual(res.status, 404, method)
                self.assertNotIn(b'secret', body)
            self.assertTrue(os.path.exists(outside.name))
        finally:
            os.unlink(os.path.join(ROOT, 'acme', 'monitor', OTHER + '.wav'))
            os.unlink(outside.name)

    def test_erases_a_file_once(self):
        res, _ = self.request('DELETE', f'/acme/{NAME}')
        self.assertEqual(res.status, 204)
        self.assertFalse(os.path.exists(os.path.join(ROOT, 'acme', 'monitor', NAME + '.wav')))
        res, _ = self.request('DELETE', f'/acme/{NAME}')
        self.assertEqual(res.status, 404)
        res, _ = self.request('GET', f'/acme/{NAME}')
        self.assertEqual(res.status, 404)

    def test_says_whether_asterisk_has_a_sound_and_nothing_else_of_the_sounds(self):
        os.makedirs(os.path.join(SOUNDS, 'custom'), exist_ok=True)
        with open(os.path.join(SOUNDS, 'custom', 'twake-recording-notice.wav'), 'wb') as f:
            f.write(b'RIFF')
        res, _ = self.request('HEAD', '/sound/custom/twake-recording-notice')
        self.assertEqual(res.status, 200)
        for path in ('/sound/custom/absent', '/sound/custom', '/sound/../etc/passwd', '/sound/custom/twake-recording-notice.wav', '/sound/'):
            res, _ = self.request('HEAD', path)
            self.assertEqual(res.status, 404, path)
        # Only to know whether it is there: no body of a sound, no sound without the token.
        res, _ = self.request('GET', '/sound/custom/twake-recording-notice')
        self.assertEqual(res.status, 405)
        res, _ = self.request('HEAD', '/sound/custom/twake-recording-notice', None)
        self.assertEqual(res.status, 401)

    def test_reads_no_more_than_the_length_it_said(self):
        path = os.path.join(ROOT, 'acme', 'monitor', NAME + '.wav')
        original = recordings.CHUNK
        recordings.CHUNK = 1000
        try:
            res, body = self.request('GET', f'/acme/{NAME}')
            self.assertEqual(len(body), int(res.getheader('Content-Length')))
            self.assertIsNone(res.getheader('Accept-Ranges'))
        finally:
            recordings.CHUNK = original
        self.assertTrue(os.path.exists(path))

    def test_takes_no_write(self):
        for method in ('POST', 'PUT', 'PATCH'):
            res, _ = self.request(method, f'/acme/{NAME}')
            self.assertEqual(res.status, 405, method)


if __name__ == '__main__':
    unittest.main()
