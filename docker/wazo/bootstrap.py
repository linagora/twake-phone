"""The accounts of the Wazo of the development and CI stack (ADR 0021), as wazo-auth-keys makes them on a Wazo.

wazo-confd, wazo-calld, wazo-amid and wazo-websocketd each get an internal account in wazo-auth with the rights
wazo-auth-keys gives them (its config.yml, tag wazo-26.10), its key written where the service reads it. TwakePhone's
Gateway gets the tenant it works in and its own account there (WAZO_TWAKEPHONE_USER, WAZO_TWAKEPHONE_PASSWORD), with
the rights provider-wazo needs and nothing else. Made with the first account of wazo-auth (bootstrap_user_* in its
configuration). Run again, it keeps the accounts whose password still works and brings their rights to these. Then it stays up: its healthcheck says the keys are there.

Standard library only: it runs with the Python of a Wazo image.
"""

import base64
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request

AUTH = os.environ.get('WAZO_AUTH_URL', 'http://127.0.0.1:9497/0.1')
KEYS = os.environ.get('WAZO_KEYS_DIR', '/var/lib/wazo-auth-keys')
BOOTSTRAP_USER = os.environ['WAZO_BOOTSTRAP_USER']
BOOTSTRAP_PASSWORD = os.environ['WAZO_BOOTSTRAP_PASSWORD']
TWAKE_TENANT = os.environ.get('WAZO_TWAKEPHONE_TENANT', 'twakephone')
TWAKE_USER = os.environ.get('WAZO_TWAKEPHONE_USER', 'twakephone')
TWAKE_PASSWORD = os.environ['WAZO_TWAKEPHONE_PASSWORD']

# wazo-auth-keys' rights for the services this stack runs (etc/wazo-auth-keys/config.yml at wazo-26.10).
SERVICES = {
    'wazo-confd': ['auth.admin.#', 'auth.tenants.read', 'auth.users.#', 'provd.#'],
    'wazo-calld': [
        'amid.action.Command.create',
        'amid.action.ConfBridgeList.create',
        'amid.action.ConfbridgeKick.create',
        'amid.action.ConfbridgeMute.create',
        'amid.action.ConfbridgeStartRecord.create',
        'amid.action.ConfbridgeStopRecord.create',
        'amid.action.ConfbridgeUnmute.create',
        'amid.action.MuteAudio.create',
        'amid.action.Originate.create',
        'amid.action.Park.create',
        'amid.action.Parkinglots.create',
        'amid.action.ParkedCalls.create',
        'amid.action.PlayDTMF.create',
        'amid.action.QueuePause.create',
        'amid.action.QueueStatus.create',
        'amid.action.Redirect.create',
        'amid.action.Setvar.create',
        'amid.action.StopMixMonitor.create',
        'amid.action.MixMonitor.create',
        'amid.action.ShowDialplan.create',
        'auth.tenants.read',
        'auth.users.*.tokens.read',
        'call-logd.voicemails.transcriptions.read',
        'confd.#',
    ],
    'wazo-amid': [],
    'wazo-websocketd': ['auth.tenants.read'],
}

# provider-wazo (step 11a): the Wazo users and their mailboxes it keeps for the people of the platform, the context of
# those mailboxes, their messages, and the events of a new message, in its tenant only.
TWAKE_ACL = [
    'confd.contexts.create',
    'confd.contexts.read',
    'confd.users.create',
    'confd.users.read',
    'confd.users.*.read',
    'confd.users.*.delete',
    'confd.users.*.voicemails.*.update',
    'confd.users.*.voicemails.delete',
    'confd.voicemails.create',
    'confd.voicemails.read',
    'confd.voicemails.*.read',
    'confd.voicemails.*.update',
    'confd.voicemails.*.delete',
    'calld.voicemails.*.read',
    'calld.voicemails.*.messages.*.read',
    'calld.voicemails.*.messages.*.update',
    'calld.voicemails.*.messages.*.delete',
    'calld.voicemails.*.messages.*.recording.read',
    'websocketd',
    # wazo-calld's user_voicemail_message_* events require exactly `events.users.<uuid>.voicemails`.
    'events.users.*.voicemails',
]


def call(method, path, body=None, token=None, basic=None, tenant=None):
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if token:
        headers['X-Auth-Token'] = token
    if basic:
        headers['Authorization'] = 'Basic ' + base64.b64encode(basic.encode()).decode()
    if tenant:
        headers['Wazo-Tenant'] = tenant
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(AUTH + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            raw = res.read()
            return res.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw)
        except ValueError:
            return err.code, raw.decode(errors='replace')


def token_for(username, password):
    status, body = call('POST', '/token', {'expiration': 600}, basic=f'{username}:{password}')
    return body['data'] if status == 200 else None


def wait_for_auth():
    for _ in range(180):
        try:
            data = token_for(BOOTSTRAP_USER, BOOTSTRAP_PASSWORD)
            if data:
                return data
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(1)
    sys.exit('wazo-auth did not answer, or refused its bootstrap account')


def check(status, body, what):
    if status >= 300:
        sys.exit(f'{what}: {status} {body}')
    return body


def ensure_policy(token, username, acl, tenant=None):
    """The policy named after `username`, with exactly the rights `acl`."""
    _, policies = call('GET', f'/policies?name={username}&recurse=true', token=token)
    items = [p for p in (policies or {}).get('items', []) if p.get('name') == username]
    if items:
        policy = items[0]
        if sorted(policy.get('acl') or []) != sorted(acl):
            check(*call('PUT', f'/policies/{policy["uuid"]}', {'name': username, 'acl': acl}, token=token), f'policy of {username}')
        return policy
    return check(*call('POST', '/policies', {'name': username, 'acl': acl}, token=token, tenant=tenant), f'policy of {username}')


def ensure_account(token, username, password, acl, purpose, tenant=None):
    """The account `username` with `password` and the rights `acl` (its policy of the same name). An account whose
    password still works is kept; its rights are brought to `acl`."""
    _, found = call('GET', f'/users?username={username}&recurse=true', token=token)
    users = [u for u in (found or {}).get('items', []) if u.get('username') == username]
    if users and token_for(username, password):
        user = users[0]
    else:
        for old in users:
            check(*call('DELETE', f'/users/{old["uuid"]}', token=token), f'removing {username}')
        body = {'username': username, 'password': password, 'purpose': purpose, 'enabled': True}
        user = check(*call('POST', '/users', body, token=token, tenant=tenant), f'creating {username}')
    policy = ensure_policy(token, username, acl, tenant)
    check(*call('PUT', f'/users/{user["uuid"]}/policies/{policy["uuid"]}', token=token, tenant=tenant), f'rights of {username}')


def key_file(service):
    return os.path.join(KEYS, f'{service}-key.yml')


def read_key(service):
    try:
        with open(key_file(service)) as f:
            lines = dict(line.split(': ', 1) for line in f.read().splitlines() if ': ' in line)
        return lines.get('service_key')
    except OSError:
        return None


def write_key(service, password):
    path = key_file(service)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        f.write(f'service_id: {service}\nservice_key: {password}\n')
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main():
    os.makedirs(KEYS, exist_ok=True)
    ready = os.path.join(KEYS, '.ready')
    if os.path.exists(ready):
        os.remove(ready)
    master = wait_for_auth()
    token = master['token']
    for service, acl in SERVICES.items():
        known = read_key(service)
        password = known if known and token_for(service, known) else secrets.token_urlsafe(24)
        ensure_account(token, service, password, acl, 'internal')
        if password != known:
            write_key(service, password)
            print(f'account of {service} made')

    _, tenants = call('GET', f'/tenants?slug={TWAKE_TENANT}', token=token)
    items = [t for t in (tenants or {}).get('items', []) if t.get('slug') == TWAKE_TENANT]
    tenant = items[0] if items else check(*call('POST', '/tenants', {'name': 'TwakePhone', 'slug': TWAKE_TENANT}, token=token), 'tenant of TwakePhone')
    ensure_account(token, TWAKE_USER, TWAKE_PASSWORD, TWAKE_ACL, 'external_api', tenant=tenant['uuid'])
    print(f'account of TwakePhone ({TWAKE_USER}) ready in tenant {tenant["uuid"]}')
    open(ready, 'w').close()
    print('Wazo accounts ready')
    while True:
        time.sleep(3600)


if __name__ == '__main__':
    main()
