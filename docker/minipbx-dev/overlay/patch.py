"""Patches MiniPBX's entrypoint and PJSIP template. Fails the build if an anchor moved."""
from pathlib import Path


def replace_once(path: str, anchor: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if text.count(anchor) != 1:
        raise SystemExit(f"anchor not found exactly once in {path}: {anchor!r}")
    p.write_text(text.replace(anchor, new))


# 1. Modules, http/ARI config, seeding: injected right before the includes are ensured.
replace_once(
    "/entrypoint.sh",
    "ensure_include /etc/asterisk/pjsip.conf pjsip_minipbx.conf",
    "/opt/twake-overlay/prepare.sh\nensure_include /etc/asterisk/pjsip.conf pjsip_minipbx.conf",
)

# 1b. ICE host candidate mapping, after the entrypoint wrote rtp.conf.
replace_once(
    "/entrypoint.sh",
    'write_config /etc/asterisk/udptl.conf "[general]"',
    '/opt/twake-overlay/prepare-rtp.sh\nwrite_config /etc/asterisk/udptl.conf "[general]"',
)

# 2. Seed before MiniPBX applies its config at startup.
replace_once(
    "/entrypoint.sh",
    "run_as_runtime_user python -m app.startup_config",
    "run_as_runtime_user env PYTHONPATH=/opt/minipbx python /opt/twake-overlay/seed.py\nrun_as_runtime_user python -m app.startup_config",
)

# 3. WebRTC transport + WebRTC endpoints (every dev extension is a browser endpoint).
tpl = "/opt/minipbx/app/templates/asterisk/pjsip_minipbx.conf.j2"
replace_once(
    tpl,
    "{% for extension in extensions if extension.enabled %}\n[{{ extension.sip_username }}]\ntype=endpoint\ncontext=minipbx-internal\ndisallow=all\nallow=ulaw,alaw\n",
    "[transport-wss]\ntype=transport\nprotocol=wss\nbind=0.0.0.0\n\n"
    "{% for extension in extensions if extension.enabled %}\n[{{ extension.sip_username }}]\ntype=endpoint\ncontext=minipbx-internal\n"
    "webrtc=yes\ntransport=transport-wss\nfrom_domain=pbx.twake.local\ndtls_auto_generate_cert=yes\ndisallow=all\nallow=opus,ulaw,alaw\n",
)

# 4. DND: Twake sets Stasis:dnd<ext>=BUSY through ARI; the dialplan honours it.
replace_once(
    "/opt/minipbx/app/templates/asterisk/extensions_minipbx.conf.j2",
    "exten => {{ extension.number }},1,Dial(PJSIP/{{ extension.sip_username }},20)\n same => n,",
    "exten => {{ extension.number }},1,GotoIf($[\"${DEVICE_STATE(Stasis:dnd{{ extension.number }})}\"=\"BUSY\"]?twake-dnd,1)\n"
    " same => n,Dial(${PJSIP_DIAL_CONTACTS({{ extension.sip_username }})},20)\n same => n,",
)
replace_once(
    "/opt/minipbx/app/templates/asterisk/extensions_minipbx.conf.j2",
    "[minipbx-internal]\n",
    "[minipbx-internal]\nexten => twake-dnd,1,Busy(5)\n",
)

# 5. Several windows per person: every open Phone window rings and may answer; disconnected ones are dropped.
#    When the limit is reached the oldest contact is evicted rather than refusing the new window.
text = Path(tpl).read_text()
old = "max_contacts=1\nremove_existing=yes\nqualify_frequency=60\n"
if old not in text:
    raise SystemExit("extension AOR anchor not found")
Path(tpl).write_text(text.replace(old, "max_contacts=10\nremove_existing=yes\nremove_unavailable=yes\nqualify_frequency=20\n", 1))

# 6. Provisioning API next to the web app (see provision.py). Disabled unless TWAKE_PROVISION_TOKEN is set.
replace_once(
    "/entrypoint.sh",
    "run_as_runtime_user uvicorn app.main:app",
    "if [ -n \"${TWAKE_PROVISION_TOKEN:-}\" ]; then\n  run_as_runtime_user env PYTHONPATH=/opt/minipbx python /opt/twake-overlay/provision.py &\nfi\nrun_as_runtime_user uvicorn app.main:app",
)

# 7. Keep the NAT pinholes of the SIP trunk open. A provider with several call servers (freepro: two IPs) may
#    deliver an inbound INVITE from any of them, but a home NAT only lets in traffic from a destination Asterisk
#    has recently sent to. One contact per call server IP, each qualified (OPTIONS every 15 s), keeps all open.
replace_once(
    tpl,
    "{% else %}\ncontact=sip:{{ trunk.host }}\n{% endif %}",
    "{% else %}\ncontact=sip:{{ trunk.host }}\n"
    "{% for ip in trunk_ips %}\ncontact=sip:{{ ip }}\n{% endfor %}\n"
    "qualify_frequency=15\nqualify_timeout=3\n{% endif %}",
)
svc = "/opt/minipbx/app/services/asterisk.py"
replace_once(
    svc,
    '        "trunk_inbound_matches": _trunk_inbound_matches(trunk),\n',
    '        "trunk_inbound_matches": _trunk_inbound_matches(trunk),\n        "trunk_ips": _trunk_ips(trunk),\n',
)
replace_once(
    svc,
    "def _trunk_inbound_matches(trunk: SipTrunk | None) -> list[str]:",
    '''def _trunk_ips(trunk: SipTrunk | None) -> list[str]:
    """IPv4 addresses of the provider host (empty when it is an IP already or cannot be resolved)."""
    import socket

    if not trunk or not trunk.host:
        return []
    try:
        found = {info[4][0] for info in socket.getaddrinfo(trunk.host, None, socket.AF_INET, socket.SOCK_DGRAM)}
    except OSError:
        return []
    return sorted(found - {trunk.host})


def _trunk_inbound_matches(trunk: SipTrunk | None) -> list[str]:''',
)
