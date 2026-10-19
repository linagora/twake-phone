"""Checks that the Wazo of the development and CI stack listens on the loopback only (step 11a, ADR 0022),
and so do LinTO STT and Synapse (step 11b, ADR 0023).

    sudo python3 docker/wazo/check-loopback.py [compose file] [project]

Every socket a process of a Wazo service (and of its bus and database) listens on, TCP or UDP, IPv4 or IPv6, read from
/proc (the processes of each container, as `docker top` gives them, their sockets, the tables of their network
namespace): one bound to an address other than 127.0.0.0/8 or ::1, any address included (0.0.0.0, ::), is printed
and the check fails. Root reads the sockets of the other processes. Exits 0 when all of them are on the loopback. CI
runs it once the stack is up and again after the SIP e2e, with what the calls opened since.

One exception, named: the DNS client of Asterisk's PJSIP (res_pjsip makes it whatever its configuration, bound to
0.0.0.0 on an ephemeral port, for the answers to its own queries, and on :: as well where the host has IPv6, as a CI
runner does; it makes none here, every address being an IP). It is recognised by what only PJSIP's own socket is, not
by its shape: a UDP socket on 0.0.0.0 (or ::) at a port of the ephemeral range
(ip_local_port_range), of the process that runs Asterisk's binary (/usr/sbin/asterisk, with PJSIP's library mapped),
and watched by the same epoll instance (PJSIP's ioqueue) as the SIP transport Asterisk was told to bind
(WAZO_SIP_LISTEN of the container). One per family at most. Another process, even one named asterisk, a socket of
Asterisk outside PJSIP's ioqueue, a second one of a family, one at a fixed port: each fails.

What stays: that socket is a real UDP listener on every address, reading DNS answers from
any source, as PJSIP's resolver does on any Asterisk. It cannot be taken away from here: without a nameserver in
/etc/resolv.conf, the C library falls back to 127.0.0.1 and PJSIP makes its socket all the same (tried on this
stack's image); res_resolver_unbound is not in Wazo's Asterisk. The stack is a development and CI one (ADR 0022);
on a Wazo, Asterisk's host firewall is Wazo's.
"""
import ipaddress
import json
import os
import socket
import struct
import subprocess
import sys

SERVICES = ['wazo-db', 'rabbitmq', 'wazo-auth', 'wazo-bootstrap', 'wazo-confd', 'wazo-confgend', 'wazo-asterisk',
            'wazo-sysconfd', 'wazo-amid', 'wazo-calld', 'wazo-websocketd',
            # Step 11b: the transcription service and the Matrix homeserver of the bot.
            'linto-stt', 'synapse']
# The states of /proc/net/tcp that listen (TCP_LISTEN), and of an unconnected UDP socket (TCP_CLOSE: bound, no peer).
LISTEN = {'tcp': '0A', 'tcp6': '0A', 'udp': '07', 'udp6': '07'}
# What the process of the DNS client is: Asterisk's binary, PJSIP's library mapped (the image's).
ASTERISK = {'exe': '/usr/sbin/asterisk', 'library': 'libasteriskpj'}


def compose(args):
    base = ['docker', 'compose', '-f', sys.argv[1] if len(sys.argv) > 1 else 'docker/docker-compose.sip.yml']
    if len(sys.argv) > 2:
        base += ['-p', sys.argv[2]]
    return subprocess.run(base + args, check=True, capture_output=True, text=True).stdout


def read(path):
    with open(path) as f:
        return f.read()


def address(hex_addr, v6):
    """An address of /proc/net/* (hexadecimal, in the host's byte order, 32-bit words for IPv6) and its port."""
    host, port = hex_addr.split(':')
    raw = bytes.fromhex(host)
    if v6:
        raw = b''.join(struct.pack('@I', struct.unpack('>I', raw[i:i + 4])[0]) for i in range(0, 16, 4))
        return ipaddress.ip_address(socket.inet_ntop(socket.AF_INET6, raw)), int(port, 16)
    return ipaddress.ip_address(struct.pack('@I', struct.unpack('>I', raw)[0])), int(port, 16)


def listening(pid):
    """The listening sockets of the network namespace of `pid`, by inode: (protocol, address, port)."""
    found = {}
    for proto, state in LISTEN.items():
        try:
            lines = read(f'/proc/{pid}/net/{proto}').splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            f = line.split()
            if f[3] != state:
                continue
            ip, port = address(f[1], proto.endswith('6'))
            found[f[9]] = (proto, ip, port)
    return found


def sockets_of(pid):
    inodes = set()
    try:
        for fd in os.listdir(f'/proc/{pid}/fd'):
            try:
                target = os.readlink(f'/proc/{pid}/fd/{fd}')
            except OSError:
                continue
            if target.startswith('socket:['):
                inodes.add(target[8:-1])
    except OSError:
        pass
    return inodes


def epolls_of(pid):
    """The epoll instances of `pid`: for each, the inodes (decimal, as /proc/net/* gives them) of what it watches."""
    found = []
    try:
        fds = os.listdir(f'/proc/{pid}/fd')
    except OSError:
        return found
    for fd in fds:
        try:
            if os.readlink(f'/proc/{pid}/fd/{fd}') != 'anon_inode:[eventpoll]':
                continue
            lines = read(f'/proc/{pid}/fdinfo/{fd}').splitlines()
        except OSError:
            continue
        watched = set()
        for line in lines:
            if not line.startswith('tfd:'):
                continue
            for field in line.split():
                if field.startswith('ino:'):
                    watched.add(str(int(field[4:], 16)))
        found.append(watched)
    return found


def is_asterisk(pid, asterisk):
    try:
        if os.readlink(f'/proc/{pid}/exe') != asterisk['exe']:
            return False
        return asterisk['library'] in read(f'/proc/{pid}/maps')
    except OSError:
        return False


def ephemeral():
    low, high = (int(x) for x in read('/proc/sys/net/ipv4/ip_local_port_range').split())
    return low, high


def check(processes, sip_listen, asterisk=ASTERISK, dns_service='wazo-asterisk'):
    """The sockets of `processes` ({service: [(pid, comm)]}) off the loopback: (allowed, bad, seen). `sip_listen` is
    where Asterisk was told to bind its SIP transport (ip:port, UDP)."""
    bad = []
    allowed = {}
    seen = 0
    low, high = ephemeral()
    sip_ip, sip_port = sip_listen.rsplit(':', 1)
    sip = (ipaddress.ip_address(sip_ip), int(sip_port))
    for service, rows in processes.items():
        if not rows:
            bad.append(f'{service}: not running')
            continue
        for pid, comm in rows:
            table = listening(pid)
            mine = sockets_of(pid)
            pjsip = None
            for inode in mine:
                if inode not in table:
                    continue
                proto, ip, port = table[inode]
                seen += 1
                if ip.is_loopback:
                    continue
                what = f'{service} ({comm}, pid {pid}): {proto} {ip}:{port}'
                any_address = (proto == 'udp' and str(ip) == '0.0.0.0') or (proto == 'udp6' and str(ip) == '::')
                if service == dns_service and any_address and low <= port <= high and proto not in allowed:
                    if pjsip is None:
                        pjsip = pjsip_ioqueue(pid, table, mine, sip, asterisk)
                    if inode in pjsip:
                        allowed[proto] = what
                        continue
                bad.append(what)
    if not seen:
        bad.append('no listening socket read (not root?)')
    return allowed, sorted(set(bad)), seen


def pjsip_ioqueue(pid, table, mine, sip, asterisk):
    """The inodes PJSIP's ioqueue watches in `pid`: those of the epoll instance that watches the SIP transport (`sip`,
    UDP), if `pid` runs Asterisk; none otherwise."""
    if not is_asterisk(pid, asterisk):
        return set()
    transport = {i for i in mine if i in table and table[i][0] == 'udp' and (table[i][1], table[i][2]) == sip}
    for watched in epolls_of(pid):
        if transport & watched:
            return watched
    return set()


def container_env(cid, name, default):
    inspected = json.loads(subprocess.run(['docker', 'inspect', cid], check=True, capture_output=True, text=True).stdout)
    for entry in inspected[0]['Config']['Env'] or []:
        key, _, value = entry.partition('=')
        if key == name:
            return value
    return default


def main():
    processes = {}
    sip_listen = '127.0.0.1:5100'
    for service in SERVICES:
        cid = compose(['ps', '-q', service]).strip()
        if not cid:
            processes[service] = []
            continue
        if service == 'wazo-asterisk':
            sip_listen = container_env(cid, 'WAZO_SIP_LISTEN', sip_listen)
        top = subprocess.run(['docker', 'top', cid, '-eo', 'pid,comm'], check=True, capture_output=True, text=True).stdout.splitlines()[1:]
        processes[service] = [(pid, comm.strip()) for pid, _, comm in (row.strip().partition(' ') for row in top)]
    allowed, bad, seen = check(processes, sip_listen)
    for line in allowed.values():
        print(f'allowed, the DNS client of PJSIP: {line}')
    for line in bad:
        print(f'NOT ON THE LOOPBACK: {line}')
    print(f'{seen} listening socket(s) of the Wazo stack, LinTO STT and Synapse read, {len(bad)} not on the loopback')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
