"""docker/wazo/sysconfd.py: its HTTP side as wazo-confd and a browser reach
it, against an AMI and a wazo-confgend of this test, on the loopback.

    python3 -I -m unittest discover -s docker/wazo/tests
"""
import http.client
import importlib.util
import os
import shutil
import socket
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from socketserver import StreamRequestHandler, ThreadingTCPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SPOOL = tempfile.mkdtemp()
os.environ.update({'SYSCONFD_AMI_PASSWORD': 'not-a-real-secret', 'SYSCONFD_SPOOL': SPOOL})
spec = importlib.util.spec_from_file_location('sysconfd', os.path.join(HERE, '..', 'sysconfd.py'))
sysconfd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sysconfd)
sysconfd.log = lambda message: None

CONTEXT = 'ctx-twake'
VOICEMAIL_CONF = f'''[general]
format = wav

[zonemessages]
eu-fr = Europe/Paris|'vm-received' q 'digits/at' kM

[{CONTEXT}]
101 => ,Alice Martin,,,maxmsg=50
102 => ,Jean Dupont,,,maxmsg=50
'''
# What VoicemailUsersList lists: one entry per mailbox (and another context's, which says nothing of these).
LISTED = [{'VMContext': CONTEXT, 'VoiceMailbox': '101'}, {'VMContext': CONTEXT, 'VoiceMailbox': '102'}, {'VMContext': 'default', 'VoiceMailbox': '1234'}]


class FakeAmi:
    """An AMI: the banner, a Login, then Reloads and VoicemailUsersList, answered as `answers` says ({module:
    (response, message, events before)}) and `listed`. Any other action is refused as Asterisk refuses an action the
    account has no privilege for. It keeps the blocks it was sent."""

    def __init__(self):
        self.blocks = []
        self.answers = {}
        self.listed = list(LISTED)
        self.auths = []  # the credentials PJSIPShowAuths lists
        self.refuse_login = False
        # While set, a Reload is not answered until it is (a reload that takes its time).
        self.gate = None
        self.on_reload = None  # called when a Reload arrives
        ami = self

        class Handler(StreamRequestHandler):
            def handle(self):
                try:
                    self.session()
                except (ConnectionResetError, BrokenPipeError):
                    pass  # sysconfd gave up on an AMI that does not answer

            def session(self):
                self.wfile.write(b'Asterisk Call Manager/9.0.0\r\n')
                block = {}
                while True:
                    line = self.rfile.readline()
                    if not line:
                        return
                    line = line.decode().rstrip('\r\n')
                    if line:
                        key, _, value = line.partition(': ')
                        block[key] = value
                        continue
                    if not block:
                        continue
                    ami.blocks.append(block)
                    self.reply(block)
                    block = {}

            def send(self, lines):
                self.wfile.write(('\r\n'.join(lines) + '\r\n\r\n').encode())

            def reply(self, block):
                action, action_id = block.get('Action'), block.get('ActionID')
                if action == 'Login':
                    ok = not ami.refuse_login and block.get('Secret') == 'not-a-real-secret'
                    self.send([f'Response: {"Success" if ok else "Error"}', f'ActionID: {action_id}', 'Message: Authentication accepted' if ok else 'Message: Authentication failed'])
                elif action == 'Reload':
                    if ami.on_reload:
                        ami.on_reload()
                    if ami.gate:
                        ami.gate.wait(10)
                    response, message, events = ami.answers.get(block.get('Module'), ('Success', 'Module Reloaded', 0))
                    for i in range(events):
                        self.send(['Event: Newchannel', f'Channel: PJSIP/opensips-{i:08x}'])
                    if events < 1000:
                        self.send([f'Response: {response}', f'ActionID: {action_id}', f'Message: {message}'])
                elif action == 'PJSIPShowAuths':
                    self.send(['Response: Success', f'ActionID: {action_id}', 'EventList: start', 'Message: A listing of Auths follows'])
                    for name in ami.auths:
                        self.send(['Event: AuthList', f'ActionID: {action_id}', 'ObjectType: auth', f'ObjectName: {name}'])
                    self.send(['Event: AuthListComplete', f'ActionID: {action_id}', 'EventList: Complete', f'ListItems: {len(ami.auths)}'])
                elif action == 'VoicemailUsersList':
                    self.send(['Response: Success', f'ActionID: {action_id}', 'EventList: start', 'Message: Voicemail user list will follow'])
                    # Another session's list in between: not this one's.
                    self.send(['Event: VoicemailUserEntry', 'ActionID: someone-else', f'VMContext: {CONTEXT}', 'VoiceMailbox: 102'])
                    for entry in ami.listed:
                        self.send(['Event: VoicemailUserEntry', f'ActionID: {action_id}'] + [f'{k}: {v}' for k, v in entry.items()])
                    self.send(['Event: VoicemailUserEntryComplete', f'ActionID: {action_id}', 'EventList: Complete', f'ListItems: {len(ami.listed)}'])
                else:
                    self.send(['Response: Error', f'ActionID: {action_id}', 'Message: Permission denied'])

        self.server = ThreadingTCPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.address = f'127.0.0.1:{self.server.server_address[1]}'

    def commands(self):
        """The actions after the login, as "Reload <module>" or the action's name."""
        return [f'Reload {b["Module"]}' if b['Action'] == 'Reload' else b['Action'] for b in self.blocks if b.get('Action') not in ('Login', 'Logoff')]


class FakeConfgend:
    """wazo-confgend: the name of a file, then the file, and the connection closed."""

    def __init__(self):
        self.conf = VOICEMAIL_CONF
        self.pjsip = ''  # asterisk/pjsip.conf
        self.asked = []
        confgend = self

        class Handler(StreamRequestHandler):
            def handle(self):
                name = self.request.recv(1024).decode()
                confgend.asked.append(name)
                self.wfile.write((confgend.pjsip if name == 'asterisk/pjsip.conf' else confgend.conf).encode())

        self.server = ThreadingTCPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.address = f'127.0.0.1:{self.server.server_address[1]}'


class Sysconfd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = ThreadingHTTPServer(('127.0.0.1', 0), sysconfd.Handler)
        cls.http.daemon_threads = True
        threading.Thread(target=cls.http.serve_forever, daemon=True).start()
        cls.port = cls.http.server_address[1]
        # The Host wazo-confd names: the address it was given.
        sysconfd.ALLOWED_HOSTS = {f'127.0.0.1:{cls.port}', f'localhost:{cls.port}'}
        # The answer after the run (and 500 for a failure): what the tests below read. The queue's own is its tests'.
        sysconfd.SYNCHRONOUS = True

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        shutil.rmtree(SPOOL, ignore_errors=True)

    def setUp(self):
        self.ami = FakeAmi()
        self.confgend = FakeConfgend()
        sysconfd.AMI = self.ami.address
        sysconfd.CONFGEND = self.confgend.address
        for entry in os.listdir(SPOOL):
            shutil.rmtree(os.path.join(SPOOL, entry))

    def tearDown(self):
        for server in (self.ami.server, self.confgend.server):
            server.shutdown()
            server.server_close()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        try:
            all_headers = {'Content-Type': 'application/json', **(headers or {})}
            conn.request(method, path, body=body, headers=all_headers)
            res = conn.getresponse()
            return res.status, res.read().decode()
        finally:
            conn.close()

    def mailbox(self, number, *messages):
        path = os.path.join(SPOOL, CONTEXT, number, 'INBOX')
        os.makedirs(path, exist_ok=True)
        for m in messages:
            with open(os.path.join(path, m), 'w') as f:
                f.write('RIFF')
        return os.path.join(SPOOL, CONTEXT, number)

    # The refusal of a browser's requests.
    def test_a_request_of_a_web_page_or_for_another_host_is_refused_and_does_nothing(self):
        box = self.mailbox('102', 'msg0000.wav')
        for headers in ({'Origin': 'https://example.test'}, {'Sec-Fetch-Site': 'cross-site'}, {'Sec-Fetch-Mode': 'no-cors'}, {'Host': f'rebind.example.test:{self.port}'}, {'Host': '127.0.0.1:1'}):
            for method, path, body in (('GET', f'/delete_voicemail?context={CONTEXT}&mailbox=102', None), ('POST', '/exec_request_handlers', '{"ipbx": ["voicemail reload"]}'), ('DELETE', '/anything', None)):
                status, _ = self.request(method, path, body, headers)
                self.assertEqual(status, 403, (headers, method, path))
        self.assertTrue(os.path.isdir(box))
        self.assertEqual(self.ami.blocks, [])
        # wazo-confd's own: the mailbox goes.
        self.assertEqual(self.request('GET', f'/delete_voicemail?context={CONTEXT}&mailbox=102')[0], 200)
        self.assertFalse(os.path.exists(box))

    def test_a_mailbox_out_of_the_spool_is_refused(self):
        # A final newline too: the names are matched whole.
        for query in ('context=..&mailbox=102', f'context={CONTEXT}&mailbox=../../etc', 'context=a/b&mailbox=1', f'context={CONTEXT}&mailbox=', f'context={CONTEXT}&mailbox=102%0A', f'context={CONTEXT}%0A&mailbox=102'):
            self.assertEqual(self.request('GET', f'/delete_voicemail?{query}')[0], 400, query)
            self.assertEqual(self.request('GET', f'/move_voicemail?old_{query.replace("&", "&old_")}&new_context={CONTEXT}&new_mailbox=105')[0], 400, query)

    # The move of a mailbox.
    def test_a_mailbox_moves_with_its_messages_where_there_is_none(self):
        self.mailbox('102', 'msg0000.wav', 'msg0000.txt')
        status, _ = self.request('GET', f'/move_voicemail?old_context={CONTEXT}&old_mailbox=102&new_context={CONTEXT}&new_mailbox=105')
        self.assertEqual(status, 200)
        self.assertFalse(os.path.exists(os.path.join(SPOOL, CONTEXT, '102')))
        self.assertEqual(sorted(os.listdir(os.path.join(SPOOL, CONTEXT, '105', 'INBOX'))), ['msg0000.txt', 'msg0000.wav'])
        # A mailbox with no message yet has no folder: nothing to move.
        self.assertEqual(self.request('GET', f'/move_voicemail?old_context={CONTEXT}&old_mailbox=103&new_context={CONTEXT}&new_mailbox=106')[0], 200)
    # as wazo-sysconfd's own source, no more (the Gateway never moves a mailbox).
    def test_a_move_replaces_whatever_the_target_held_as_wazo_sysconfd_does(self):
        self.mailbox('102', 'msg0000.wav')
        self.mailbox('105', 'msg0000.wav', 'msg0001.wav')
        status, body = self.request('GET', f'/move_voicemail?old_context={CONTEXT}&old_mailbox=102&new_context={CONTEXT}&new_mailbox=105')
        self.assertEqual(status, 200, body)
        # At 105, the mailbox moved there and nothing else (rm -rf, then mv); nothing left at 102; no copy anywhere.
        self.assertEqual(os.listdir(os.path.join(SPOOL, CONTEXT, '105', 'INBOX')), ['msg0000.wav'])
        self.assertFalse(os.path.exists(os.path.join(SPOOL, CONTEXT, '102')))
        self.assertEqual(sorted(os.listdir(SPOOL)), [CONTEXT])
        self.assertEqual(sorted(os.listdir(os.path.join(SPOOL, CONTEXT))), ['105'])
        # A mailbox with no folder moved onto messages: nothing done, they stay where they were (wazo-sysconfd too).
        self.mailbox('106', 'msg0000.wav')
        self.assertEqual(self.request('GET', f'/move_voicemail?old_context={CONTEXT}&old_mailbox=103&new_context={CONTEXT}&new_mailbox=106')[0], 200)
        self.assertEqual(os.listdir(os.path.join(SPOOL, CONTEXT, '106', 'INBOX')), ['msg0000.wav'])
        # A move onto itself changes nothing.
        self.assertEqual(self.request('GET', f'/move_voicemail?old_context={CONTEXT}&old_mailbox=105&new_context={CONTEXT}&new_mailbox=105')[0], 200)
        self.assertEqual(os.listdir(os.path.join(SPOOL, CONTEXT, '105', 'INBOX')), ['msg0000.wav'])
        # A deletion takes the whole folder, and one with none is no error.
        self.assertEqual(self.request('GET', f'/delete_voicemail?context={CONTEXT}&mailbox=105')[0], 200)
        self.assertFalse(os.path.exists(os.path.join(SPOOL, CONTEXT, '105')))
        self.assertEqual(self.request('GET', f'/delete_voicemail?context={CONTEXT}&mailbox=105')[0], 200)

    # The Asterisk commands (AMI actions, never the CLI).
    def test_a_command_runs_on_its_own_account_with_no_event_as_the_reload_of_its_module(self):
        self.assertEqual(self.request('POST', '/exec_request_handlers', '{"ipbx": ["dialplan reload", "core stop now", "module reload features", "module reload res_pjsip.so", "module reload app_queue.so"]}')[0], 200)
        login = self.ami.blocks[0]
        self.assertEqual((login['Action'], login['Username'], login['Events']), ('Login', 'twake_sysconfd', 'off'))
        # Only the commands of the list, each the reload of its module; no Command action, ever.
        self.assertEqual(self.ami.commands(), ['Reload pbx_config.so', 'Reload features', 'Reload res_pjsip.so', 'Reload app_queue.so'])
        self.assertFalse(any(b.get('Action') == 'Command' for b in self.ami.blocks))

    def test_a_module_a_wazo_may_not_load_is_nothing_to_reload_any_other_missing_fails(self):
        self.ami.answers['chan_sccp.so'] = ('Error', 'No such module', 0)
        self.assertEqual(self.request('POST', '/exec_request_handlers', '{"ipbx": ["module reload chan_sccp.so", "dialplan reload"]}')[0], 200)
        self.assertEqual(self.ami.commands(), ['Reload chan_sccp.so', 'Reload pbx_config.so'])
        self.ami.answers['pbx_config.so'] = ('Error', 'No such module', 0)
        self.assertEqual(self.request('POST', '/exec_request_handlers', '{"ipbx": ["dialplan reload"]}')[0], 500)

    def test_a_command_asterisk_refuses_or_does_not_answer_fails_500(self):
        self.ami.answers['pbx_config.so'] = ('Error', 'An unknown error occurred', 0)
        status, body = self.request('POST', '/exec_request_handlers', '{"ipbx": ["dialplan reload", "module reload res_pjsip.so"]}')
        self.assertEqual(status, 500, body)
        self.assertIn('refused Reload pbx_config.so', body)
        # The next one runs all the same, as wazo-sysconfd's Command.execute catches each failure.
        self.assertEqual(self.ami.commands(), ['Reload pbx_config.so', 'Reload res_pjsip.so'])
        # Events, and never the answer: an error, not a wait.
        self.ami.answers['pbx_config.so'] = ('Success', 'Module Reloaded', 1000)
        self.assertEqual(self.request('POST', '/exec_request_handlers', '{"ipbx": ["dialplan reload"]}')[0], 500)
        # Under the bound, the answer after the events is found.
        self.ami.answers['pbx_config.so'] = ('Success', 'Module Reloaded', 50)
        self.assertEqual(self.request('POST', '/exec_request_handlers', '{"ipbx": ["dialplan reload"]}')[0], 200)

    def test_a_login_refused_or_an_ami_out_of_reach_fails_500(self):
        self.ami.refuse_login = True
        self.assertEqual(self.request('POST', '/exec_request_handlers', '{"ipbx": ["dialplan reload"]}')[0], 500)
        self.ami.server.shutdown()
        self.ami.server.server_close()
        self.assertEqual(self.request('POST', '/exec_request_handlers', '{"ipbx": ["dialplan reload"]}')[0], 500)

    def test_a_voicemail_reload_is_checked_by_the_mailboxes_asterisk_has_after_it(self):
        self.assertEqual(self.request('POST', '/exec_request_handlers', '{"ipbx": ["voicemail reload"]}')[0], 200)
        self.assertEqual(self.confgend.asked, ['asterisk/voicemail.conf'] * 2)
        self.assertEqual(self.ami.commands(), ['Reload app_voicemail.so', 'VoicemailUsersList'])
        # A reload that said Success but did not read the configuration: Jean's mailbox is not in Asterisk (the entry of
        # another session's list, at 102 or not, says nothing of this one's).
        self.ami.listed = [e for e in LISTED if e['VoiceMailbox'] != '102']
        status, body = self.request('POST', '/exec_request_handlers', '{"ipbx": ["voicemail reload"]}')
        self.assertEqual(status, 500, body)
        self.assertIn(f'102@{CONTEXT}', body)
        # wazo-confgend out of reach: no reload (Asterisk would read nothing).
        self.ami.blocks.clear()
        self.confgend.server.shutdown()
        self.confgend.server.server_close()
        self.assertEqual(self.request('POST', '/exec_request_handlers', '{"ipbx": ["voicemail reload"]}')[0], 500)
        self.assertEqual(self.ami.commands(), [])

    def test_a_pjsip_reload_is_checked_by_the_credentials_asterisk_has_after_it_and_made_again_when_one_is_missing(self):
        sysconfd.PJSIP_SETTLE_S = 1
        self.confgend.pjsip = '[101]\ntype = endpoint\n\n[101]\ntype=auth\n\n[103]\ntype = auth\nusername = 103\n'
        self.ami.auths = ['101', '103']
        self.assertEqual(self.request('POST', '/exec_request_handlers', '{"ipbx": ["module reload res_pjsip.so"]}')[0], 200)
        self.assertEqual(self.ami.commands(), ['Reload res_pjsip.so', 'PJSIPShowAuths'])
        # A reload dropped: 103 is not there, the reload is made again (and again), then it is an error.
        self.ami.blocks.clear()
        self.ami.auths = ['101']
        status, body = self.request('POST', '/exec_request_handlers', '{"ipbx": ["module reload res_pjsip.so"]}')
        self.assertEqual(status, 500, body)
        self.assertIn('103', body)
        self.assertEqual(self.ami.commands().count(f'Reload res_pjsip.so'), sysconfd.PJSIP_RELOADS)

    # The queue: as wazo-sysconfd's, a request is answered at once and what waits is not queued twice.
    def post_in_background(self, command):
        results = []
        t = threading.Thread(target=lambda: results.append(self.request('POST', '/exec_request_handlers', '{"ipbx": ["%s"]}' % command)))
        t.start()
        return t, results

    def test_a_burst_of_requests_costs_one_reload_while_one_runs_and_one_for_all_the_others(self):
        sysconfd.SYNCHRONOUS = False
        self.addCleanup(setattr, sysconfd, 'SYNCHRONOUS', True)
        self.ami.gate = threading.Event()
        # The first request is taken by the worker at once and waits for Asterisk; the 20 after it are merged in one.
        self.assertEqual(self.request('POST', '/exec_request_handlers', '{"ipbx": ["module reload res_pjsip.so"]}')[0], 200)
        for _ in range(100):
            if self.ami.commands() == ['Reload res_pjsip.so']:
                break
            threading.Event().wait(0.05)
        for _ in range(20):
            status, body = self.request('POST', '/exec_request_handlers', '{"ipbx": ["module reload res_pjsip.so", "voicemail reload"]}')
            self.assertEqual(status, 200, body)
            self.assertIn('request_uuid', body)
        self.ami.gate.set()
        for _ in range(100):
            if self.ami.commands().count('VoicemailUsersList') == 1 and len(self.ami.commands()) == 4:
                break
            threading.Event().wait(0.05)
        threading.Event().wait(0.3)
        # One for the first request, one for the twenty (and one voicemail reload, checked as ever), not twenty-one.
        self.assertEqual(self.ami.commands(), ['Reload res_pjsip.so', 'Reload res_pjsip.so', 'Reload app_voicemail.so', 'VoicemailUsersList'])

    def test_a_failure_of_a_command_is_not_the_answer_of_an_asynchronous_request(self):
        sysconfd.SYNCHRONOUS = False
        self.addCleanup(setattr, sysconfd, 'SYNCHRONOUS', True)
        self.ami.answers['pbx_config.so'] = ('Error', 'An unknown error occurred', 0)
        self.assertEqual(self.request('POST', '/exec_request_handlers', '{"ipbx": ["dialplan reload"]}')[0], 200)

    def test_the_worker_goes_on_whatever_happens_and_a_request_always_ends(self):
        class Broken:
            commands = []
            done = threading.Event()

            def run(self):
                raise RuntimeError('boom')

        sysconfd.QUEUE.put(Broken())
        self.assertEqual(self.request('POST', '/exec_request_handlers', '{"ipbx": ["dialplan reload"]}')[0], 200)
        self.assertEqual(self.ami.commands(), ['Reload pbx_config.so'])
        # A log that fails while a command failed: the request ends all the same (done is set in a finally), and the worker lives.
        self.ami.answers['pbx_config.so'] = ('Error', 'An unknown error occurred', 0)
        real_log = sysconfd.log
        def failing_log(message):
            if 'failed' in message:
                raise RuntimeError('log broken')
        sysconfd.log = failing_log
        try:
            self.request('POST', '/exec_request_handlers', '{"ipbx": ["dialplan reload"]}')
        finally:
            sysconfd.log = real_log
        self.ami.answers.clear()
        self.assertEqual(self.request('POST', '/exec_request_handlers', '{"ipbx": ["module reload features"]}')[0], 200)
        self.assertEqual(self.ami.commands()[-1], 'Reload features')

    def test_only_the_reload_of_pjsip_lasts_what_it_is_told_to(self):
        sysconfd.RELOAD_MS = 300
        self.addCleanup(setattr, sysconfd, 'RELOAD_MS', 0)
        start = time.monotonic()
        self.assertEqual(self.request('POST', '/exec_request_handlers', '{"ipbx": ["dialplan reload", "voicemail reload"]}')[0], 200)
        self.assertLess(time.monotonic() - start, 0.25)
        start = time.monotonic()
        self.assertEqual(self.request('POST', '/exec_request_handlers', '{"ipbx": ["module reload res_pjsip.so"]}')[0], 200)
        self.assertGreaterEqual(time.monotonic() - start, 0.3)

    def test_a_voicemail_reload_ignores_a_mailbox_deleted_between_its_two_readings(self):
        # Jean's mailbox is deleted while Asterisk reloads: wazo-confgend no longer gives it, Asterisk no longer lists it.
        def deleted():
            self.confgend.conf = VOICEMAIL_CONF.replace("102 => ,Jean Dupont,,,maxmsg=50\n", '')
            self.ami.listed = [e for e in LISTED if e['VoiceMailbox'] != '102']
        self.ami.on_reload = deleted
        status, body = self.request('POST', '/exec_request_handlers', '{"ipbx": ["voicemail reload"]}')
        self.assertEqual(status, 200, body)

    def test_the_failure_of_a_command_is_the_failure_of_the_request_it_was_merged_into_too(self):
        self.ami.gate = threading.Event()
        self.ami.answers['pbx_config.so'] = ('Error', 'An unknown error occurred', 0)
        first, first_results = self.post_in_background('module reload features')
        for _ in range(100):
            if self.ami.commands() == ['Reload features']:
                break
            time.sleep(0.05)
        second, second_results = self.post_in_background('dialplan reload')
        time.sleep(0.2)
        third, third_results = self.post_in_background('dialplan reload')
        time.sleep(0.2)
        self.ami.gate.set()
        for t in (first, second, third):
            t.join(15)
        self.assertEqual([r[0][0] for r in (first_results, second_results, third_results)], [200, 500, 500])
        self.assertEqual(self.ami.commands().count('Reload pbx_config.so'), 1)

    def test_it_says_when_its_queue_is_empty(self):
        said = []
        real_log = sysconfd.log
        sysconfd.log = said.append
        self.addCleanup(setattr, sysconfd, 'log', real_log)
        self.assertEqual(self.request('POST', '/exec_request_handlers', '{"ipbx": ["module reload features"]}')[0], 200)
        for _ in range(100):
            if 'idle' in said:
                break
            time.sleep(0.05)
        self.assertEqual([m for m in said if m in ('ran \'module reload features\'', 'idle')], ["ran 'module reload features'", 'idle'])

    def test_the_mailboxes_of_a_voicemail_conf_and_of_the_amis_list(self):
        self.assertEqual(sysconfd.mailboxes_of(VOICEMAIL_CONF), {(CONTEXT, '101'), (CONTEXT, '102')})
        self.assertEqual(sysconfd.mailboxes_listed(LISTED + [{'VMContext': '../x', 'VoiceMailbox': '1'}, {'VMContext': CONTEXT}]), {(CONTEXT, '101'), (CONTEXT, '102'), ('default', '1234')})


if __name__ == '__main__':
    unittest.main()
