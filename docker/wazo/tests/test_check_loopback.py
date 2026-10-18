"""docker/wazo/check-loopback.py (second review 11a, n°4 and n°13), on processes of this test: no Docker, no root.

    python3 -I -m unittest discover -s docker/wazo/tests

Each case starts a process with the sockets it is given (a copy of the Python interpreter named asterisk, as the
listener that passed the first version of the check), then runs the check on it.
"""
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('check_loopback', os.path.join(HERE, '..', 'check-loopback.py'))
check_loopback = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_loopback)

# The process: binds the sockets it is given, puts them in the epoll instances they name, says their ports, waits.
LISTENER = r'''
import json, os, select, socket, sys, time
plan = json.loads(sys.argv[1])
polls = {}
ports = []
keep = []
for s in plan:
    family = socket.AF_INET6 if ':' in s['address'] else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM if s.get('tcp') else socket.SOCK_DGRAM)
    if family == socket.AF_INET6:
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    sock.bind((s['address'], s.get('port', 0)))
    if s.get('tcp'):
        sock.listen()
    if s.get('epoll') is not None:
        polls.setdefault(s['epoll'], select.epoll()).register(sock.fileno(), select.EPOLLIN)
    keep.append(sock)
    ports.append(sock.getsockname()[1])
with open(sys.argv[2] + '.part', 'w') as f:
    f.write(json.dumps(ports))
os.rename(sys.argv[2] + '.part', sys.argv[2])
time.sleep(60)
'''


def has_ipv6():
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_DGRAM) as s:
            s.bind(('::1', 0))
        return True
    except OSError:
        return False


class CheckLoopback(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.exe = os.path.join(self.dir, 'asterisk')
        shutil.copy(sys.executable, self.exe)
        self.children = []
        # The copy stands for Asterisk's binary in the cases that say so: its path, and itself as the mapped library.
        self.as_asterisk = {'exe': self.exe, 'library': self.exe}

    def tearDown(self):
        for child in self.children:
            child.kill()
            child.wait()
        shutil.rmtree(self.dir, ignore_errors=True)

    def listener(self, plan):
        """A process with the sockets of `plan`: its pid and their ports."""
        out = os.path.join(self.dir, f'ports-{len(self.children)}')
        child = subprocess.Popen([self.exe, '-I', '-c', LISTENER, json.dumps(plan), out])
        self.children.append(child)
        for _ in range(100):
            if os.path.exists(out):
                with open(out) as f:
                    return str(child.pid), json.loads(f.read())
            if child.poll() is not None:
                self.fail(f'the listener exited: {child.returncode}')
            time.sleep(0.05)
        self.fail('the listener did not start')

    def test_a_listener_on_every_address_named_asterisk_fails(self):
        # The case of the second review: the shape of the DNS client, from another program.
        pid, ports = self.listener([{'address': '0.0.0.0'}])
        allowed, bad, _ = check_loopback.check({'wazo-asterisk': [(pid, 'asterisk')]}, '127.0.0.1:5100')
        self.assertEqual(allowed, {})
        self.assertEqual(bad, [f'wazo-asterisk (asterisk, pid {pid}): udp 0.0.0.0:{ports[0]}'])

    def test_a_listener_of_the_asterisk_binary_outside_the_ioqueue_of_its_sip_transport_fails(self):
        # The SIP transport in one epoll instance, the socket on every address in none, then in another one.
        for epoll in (None, 1):
            pid, ports = self.listener([{'address': '127.0.0.1', 'epoll': 0}, {'address': '0.0.0.0', 'epoll': epoll}])
            allowed, bad, _ = check_loopback.check({'wazo-asterisk': [(pid, 'asterisk')]}, f'127.0.0.1:{ports[0]}', self.as_asterisk)
            self.assertEqual(allowed, {}, epoll)
            self.assertEqual(bad, [f'wazo-asterisk (asterisk, pid {pid}): udp 0.0.0.0:{ports[1]}'], epoll)

    def test_the_dns_client_of_pjsip_passes(self):
        plan = [{'address': '127.0.0.1', 'epoll': 0}, {'address': '0.0.0.0', 'epoll': 0}]
        if has_ipv6():
            plan.append({'address': '::', 'epoll': 0})
        pid, ports = self.listener(plan)
        allowed, bad, seen = check_loopback.check({'wazo-asterisk': [(pid, 'asterisk')]}, f'127.0.0.1:{ports[0]}', self.as_asterisk)
        self.assertEqual(bad, [])
        self.assertEqual(seen, len(plan))
        self.assertEqual(allowed['udp'], f'wazo-asterisk (asterisk, pid {pid}): udp 0.0.0.0:{ports[1]}')
        self.assertEqual(sorted(allowed), ['udp', 'udp6'] if has_ipv6() else ['udp'])

    def test_not_the_binary_named_not_the_service_named(self):
        pid, ports = self.listener([{'address': '127.0.0.1', 'epoll': 0}, {'address': '0.0.0.0', 'epoll': 0}])
        sip = f'127.0.0.1:{ports[0]}'
        # The default binary (/usr/sbin/asterisk) is not this one.
        self.assertEqual(check_loopback.check({'wazo-asterisk': [(pid, 'asterisk')]}, sip)[1], [f'wazo-asterisk (asterisk, pid {pid}): udp 0.0.0.0:{ports[1]}'])
        # Nor is PJSIP's library mapped.
        self.assertEqual(check_loopback.check({'wazo-asterisk': [(pid, 'asterisk')]}, sip, {'exe': self.exe, 'library': 'libasteriskpj'})[1], [f'wazo-asterisk (asterisk, pid {pid}): udp 0.0.0.0:{ports[1]}'])
        # Another service.
        self.assertEqual(check_loopback.check({'wazo-calld': [(pid, 'asterisk')]}, sip, self.as_asterisk)[1], [f'wazo-calld (asterisk, pid {pid}): udp 0.0.0.0:{ports[1]}'])
        # Another SIP transport than the one Asterisk was told to bind.
        self.assertEqual(check_loopback.check({'wazo-asterisk': [(pid, 'asterisk')]}, f'127.0.0.1:{ports[0] + 1}', self.as_asterisk)[0], {})

    def fixed_port(self):
        """A free UDP port below the ephemeral range (ip_local_port_range)."""
        low, _ = check_loopback.ephemeral()
        for port in range(low - 1, max(1024, low - 2000), -1):
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                    s.bind(('0.0.0.0', port))
                return port
            except OSError:
                continue
        self.fail('no free port below the ephemeral range')

    def test_the_only_listener_on_every_address_at_a_fixed_port_fails_in_the_ioqueue_of_asterisk(self):
        # Third review 11a, n°9: everything of PJSIP's DNS client but its port, one outside ip_local_port_range.
        fixed = self.fixed_port()
        pid, ports = self.listener([{'address': '127.0.0.1', 'epoll': 0}, {'address': '0.0.0.0', 'port': fixed, 'epoll': 0}])
        allowed, bad, _ = check_loopback.check({'wazo-asterisk': [(pid, 'asterisk')]}, f'127.0.0.1:{ports[0]}', self.as_asterisk)
        self.assertEqual(allowed, {})
        self.assertEqual(bad, [f'wazo-asterisk (asterisk, pid {pid}): udp 0.0.0.0:{fixed}'])

    def test_one_per_family_an_ephemeral_port_udp_only(self):
        fixed = self.fixed_port()
        pid, ports = self.listener([
            {'address': '127.0.0.1', 'epoll': 0},
            {'address': '0.0.0.0', 'epoll': 0},
            {'address': '0.0.0.0', 'epoll': 0},
            {'address': '0.0.0.0', 'port': fixed, 'epoll': 0},
            {'address': '0.0.0.0', 'tcp': True, 'epoll': 0},
        ])
        allowed, bad, _ = check_loopback.check({'wazo-asterisk': [(pid, 'asterisk')]}, f'127.0.0.1:{ports[0]}', self.as_asterisk)
        self.assertEqual(list(allowed), ['udp'])
        self.assertEqual(len(bad), 3)
        self.assertIn(f'wazo-asterisk (asterisk, pid {pid}): udp 0.0.0.0:{fixed}', bad)
        self.assertIn(f'wazo-asterisk (asterisk, pid {pid}): tcp 0.0.0.0:{ports[4]}', bad)

    def test_a_service_not_running_and_nothing_read_fail(self):
        allowed, bad, seen = check_loopback.check({'wazo-asterisk': []}, '127.0.0.1:5100')
        self.assertEqual(bad, ['no listening socket read (not root?)', 'wazo-asterisk: not running'])
        self.assertEqual((allowed, seen), ({}, 0))

    def test_the_loopback_passes(self):
        plan = [{'address': '127.0.0.1'}, {'address': '127.0.0.1', 'tcp': True}]
        if has_ipv6():
            plan.append({'address': '::1', 'tcp': True})
        pid, _ = self.listener(plan)
        self.assertEqual(check_loopback.check({'wazo-db': [(pid, 'postgres')]}, '127.0.0.1:5100'), ({}, [], len(plan)))


if __name__ == '__main__':
    unittest.main()
