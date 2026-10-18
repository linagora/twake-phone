"""Checks that the Wazo of the development and CI stack listens on the loopback only (step 11a, ADR 0022).

    sudo python3 docker/wazo/check-loopback.py [compose file] [project]

Every socket a process of a Wazo service (and of its bus and database) listens on, TCP or UDP, IPv4 or IPv6, read from
/proc (the processes of each container, as `docker top` gives them, their sockets, the tables of their network
namespace): one bound to an address other than 127.0.0.0/8 or ::1, any address included (0.0.0.0, ::), is printed
and the check fails. Root reads the sockets of the other processes. Exits 0 when all of them are on the loopback.

One exception, named: the DNS client of Asterisk's PJSIP (res_pjsip makes it whatever its configuration, bound to
0.0.0.0 on an ephemeral port, for the answers to its own queries; it makes none here, every address being an IP). One
UDP socket of the asterisk process on 0.0.0.0 at a port of the ephemeral range (ip_local_port_range), no more: any
other one, a second one, or one at a fixed port fails.
"""
import ipaddress
import os
import socket
import struct
import subprocess
import sys

SERVICES = ['wazo-db', 'rabbitmq', 'wazo-auth', 'wazo-bootstrap', 'wazo-confd', 'wazo-confgend', 'wazo-asterisk',
            'wazo-sysconfd', 'wazo-amid', 'wazo-calld', 'wazo-websocketd']
# The states of /proc/net/tcp that listen (TCP_LISTEN), and of an unconnected UDP socket (TCP_CLOSE: bound, no peer).
LISTEN = {'tcp': '0A', 'tcp6': '0A', 'udp': '07', 'udp6': '07'}


def compose(args):
    base = ['docker', 'compose', '-f', sys.argv[1] if len(sys.argv) > 1 else 'docker/docker-compose.sip.yml']
    if len(sys.argv) > 2:
        base += ['-p', sys.argv[2]]
    return subprocess.run(base + args, check=True, capture_output=True, text=True).stdout


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
            lines = open(f'/proc/{pid}/net/{proto}').read().splitlines()[1:]
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


def ephemeral():
    low, high = (int(x) for x in open('/proc/sys/net/ipv4/ip_local_port_range').read().split())
    return low, high


def main():
    bad = []
    seen = 0
    low, high = ephemeral()
    dns_client = []
    for service in SERVICES:
        cid = compose(['ps', '-q', service]).strip()
        if not cid:
            bad.append(f'{service}: not running')
            continue
        top = subprocess.run(['docker', 'top', cid, '-eo', 'pid,comm'], check=True, capture_output=True, text=True).stdout.splitlines()[1:]
        for row in top:
            pid, _, comm = row.strip().partition(' ')
            table = listening(pid)
            for inode in sockets_of(pid):
                if inode not in table:
                    continue
                proto, ip, port = table[inode]
                seen += 1
                if ip.is_loopback:
                    continue
                what = f'{service} ({comm.strip()}, pid {pid}): {proto} {ip}:{port}'
                if service == 'wazo-asterisk' and comm.strip() == 'asterisk' and proto == 'udp' and str(ip) == '0.0.0.0' and low <= port <= high and not dns_client:
                    dns_client.append(what)
                    continue
                bad.append(what)
    if not seen:
        bad.append('no listening socket read (not root?)')
    for line in dns_client:
        print(f'allowed, the DNS client of PJSIP: {line}')
    for line in sorted(set(bad)):
        print(f'NOT ON THE LOOPBACK: {line}')
    print(f'{seen} listening socket(s) of the Wazo stack read, {len(set(bad))} not on the loopback')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
