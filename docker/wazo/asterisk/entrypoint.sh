#!/bin/bash
# Asterisk of Wazo (wazoplatform/asterisk, ADR 0022) for the development and CI stack: Wazo's own configuration, with
# what this stack replaces. Wazo's packaging includes every file of /etc/asterisk/*.d; the files written here take the
# place of Wazo's for the SIP side (a single trunk, OpenSIPS's socket for Wazo), the media and the dialplan (calls
# OpenSIPS sends to a mailbox), and add the AMI accounts of wazo-amid, of this stack's wazo-sysconfd and of the Gateway. The voicemails
# come from Wazo's database through wazo-confgend, as on a Wazo (voicemail.d/01-wazo.conf), with the format of the
# recordings set here (wav: what the Gateway's bound on a recording's size counts); so does
# modules.conf, read once here.
#
#   WAZO_SIP_LISTEN    where Asterisk takes SIP (ip:port, UDP; 127.0.0.1:5100 by default)
#   WAZO_OPENSIPS      OpenSIPS's socket for Wazo (ip:port, its WAZO_LISTEN_IP:WAZO_PORT): the only party it hears
#   WAZO_RTP_ADDRESS   the address of its media (127.0.0.1 by default), WAZO_RTP_MIN and WAZO_RTP_MAX its UDP ports
#   WAZO_CONFGEND      wazo-confgend (ip:port, 127.0.0.1:8669 by default)
#   WAZO_AMI_PASSWORD  the password of wazo-amid's AMI account (this stack's own, as in wazo-amid's configuration)
#   WAZO_SYSCONFD_AMI_PASSWORD
#                      the password of the AMI account of docker/wazo/sysconfd.py (its own: reloads, no event)
#   WAZO_GATEWAY_AMI_PASSWORD, WAZO_GATEWAY_ORIGINATE_PASSWORD
#                      the passwords of the two AMI accounts of the Gateway (step 11d, ADR 0029): the calls in progress
#                      and MixMonitor; Originate (the recording notice, a supervisor's call), nothing else
#   WAZO_ARI_PASSWORD  the password of the ARI account of wazo-calld and wazo-confd (this stack's own, as in theirs)
#   WAZO_DB            Wazo's database (ip:port, 127.0.0.1:54330 by default), WAZO_DB_PASSWORD its password
#   VOICEMAIL_MAX_CALL_SEC
#                      the longest a call to a mailbox lasts, Asterisk's side (300 s by default, OpenSIPS's too)
#
# Everything it listens on is on the loopback (docker/wazo/check-loopback.py says so in CI): SIP and
# its media where they are told, the AMI and the HTTP server of ARI (127.0.0.1:5039), and no channel or service this
# stack does not use (IAX2, SCCP, DUNDi). One socket only is on every address (one per family: 0.0.0.0, and :: where
# the host has IPv6), which this Asterisk always makes: the DNS client of PJSIP (an ephemeral port that takes the
# answers to its own queries; it makes none here, every address being an IP). It keeps no call log of its own (CDR, CEL,
# queue_log) and does not trace the dialplan to its log (no -v): the history of
# the calls is the Gateway's, and the number of a caller is not in Docker's log. Its SIP answers name no software
# (user_agent; OpenSIPS takes Server and User-Agent off what it relays to the operator anyway).
set -euo pipefail
: "${WAZO_SIP_LISTEN:=127.0.0.1:5100}"
: "${WAZO_OPENSIPS:=127.0.0.1:5095}"
: "${WAZO_RTP_ADDRESS:=127.0.0.1}"
: "${WAZO_RTP_MIN:=32000}"
: "${WAZO_RTP_MAX:=32100}"
: "${WAZO_CONFGEND:=127.0.0.1:8669}"
: "${WAZO_AMI_PASSWORD:=twake-wazo-dev-only-ami}"
: "${WAZO_SYSCONFD_AMI_PASSWORD:=twake-wazo-dev-only-sysconfd}"
: "${WAZO_GATEWAY_AMI_PASSWORD:=twake-wazo-dev-only-gateway-ami}"
: "${WAZO_GATEWAY_ORIGINATE_PASSWORD:=twake-wazo-dev-only-gateway-originate}"
: "${WAZO_ARI_PASSWORD:=twake-wazo-dev-only-ari}"
: "${WAZO_DB:=127.0.0.1:54330}"
: "${WAZO_DB_PASSWORD:=twake-wazo-dev-only-db}"
: "${VOICEMAIL_MAX_CALL_SEC:=300}"

ip_port='^([0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]{1,5}$'
for v in WAZO_SIP_LISTEN WAZO_OPENSIPS WAZO_CONFGEND WAZO_DB; do
  [[ ${!v} =~ $ip_port ]] || { echo "$v must be ip:port (got ${!v})" >&2; exit 1; }
done
[[ $WAZO_RTP_ADDRESS =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "WAZO_RTP_ADDRESS must be an IPv4 address" >&2; exit 1; }
[[ $WAZO_RTP_MIN =~ ^[0-9]+$ && $WAZO_RTP_MAX =~ ^[0-9]+$ && $WAZO_RTP_MIN -lt $WAZO_RTP_MAX ]] || { echo "WAZO_RTP_MIN and WAZO_RTP_MAX must be ports, the first below the second" >&2; exit 1; }
for v in WAZO_AMI_PASSWORD WAZO_SYSCONFD_AMI_PASSWORD WAZO_GATEWAY_AMI_PASSWORD WAZO_GATEWAY_ORIGINATE_PASSWORD WAZO_ARI_PASSWORD WAZO_DB_PASSWORD; do
  [[ ${!v} =~ ^[A-Za-z0-9._-]{8,64}$ ]] || { echo "$v: 8 to 64 letters, digits, '.', '_' or '-'" >&2; exit 1; }
done
[[ $VOICEMAIL_MAX_CALL_SEC =~ ^[0-9]{2,4}$ && $VOICEMAIL_MAX_CALL_SEC -ge 30 && $VOICEMAIL_MAX_CALL_SEC -le 3600 ]] || { echo "VOICEMAIL_MAX_CALL_SEC must be 30 to 3600 seconds" >&2; exit 1; }
opensips_ip=${WAZO_OPENSIPS%:*}

# wazo-confgend's client, as Wazo's wazo-confgen does it (one request, the file in the answer), for the #exec of
# Wazo's configuration files: the image has no Python.
cat > /usr/bin/wazo-confgen <<EOF
#!/bin/bash
# wazo-confgen <frontend/file> [--cached|--invalidate]
cmd=\$1; shift
for a in "\$@"; do case \$a in --cached) cmd="\$cmd cached";; --invalidate) cmd="\$cmd invalidate";; esac; done
exec 3<>/dev/tcp/${WAZO_CONFGEND%:*}/${WAZO_CONFGEND#*:}
printf '%s' "\$cmd" >&3
cat <&3
EOF
chmod 755 /usr/bin/wazo-confgen

# The mailboxes, from Wazo's database, with the format of the recordings this stack's Gateway expects whatever Wazo's
# configuration says (wav: 8 kHz, 16 bits, 16000 bytes a second).
cat > /usr/bin/twake-voicemail-conf <<'EOF'
#!/bin/bash
set -o pipefail
wazo-confgen asterisk/voicemail.conf | sed -E -e '/^format[[:space:]]*=/d' -e '/^\[general\][[:space:]]*$/a format = wav'
EOF
chmod 755 /usr/bin/twake-voicemail-conf
printf '#exec /usr/bin/twake-voicemail-conf\n' > /etc/asterisk/voicemail.d/01-wazo.conf

for i in $(seq 1 120); do
  if (exec 3<>"/dev/tcp/${WAZO_CONFGEND%:*}/${WAZO_CONFGEND#*:}") 2>/dev/null; then break; fi
  [ "$i" = 120 ] && { echo "wazo-confgend did not answer at $WAZO_CONFGEND" >&2; exit 1; }
  sleep 1
done
wazo-confgen asterisk/modules.conf > /etc/asterisk/modules.conf
grep -q '^\[modules\]' /etc/asterisk/modules.conf || { echo "wazo-confgend gave no modules.conf" >&2; exit 1; }
# Channels and services Wazo loads that this stack does not use, each listening on every address: not loaded.
cat >> /etc/asterisk/modules.conf <<EOF
; This stack (docker/wazo/asterisk/entrypoint.sh): nothing listens off the loopback.
noload => chan_iax2.so
noload => chan_sccp.so
noload => pbx_dundi.so
EOF

# SIP: one UDP transport, one endpoint, OpenSIPS's socket for Wazo, recognised by its address; nothing else may call.
# Its media as a browser's (webrtc: DTLS-SRTP, ICE, rtcp-mux, AVPF): OpenSIPS gives a mailbox the offer rtpengine made
# for the windows of the person called, which may have rung already.
cat > /etc/asterisk/pjsip.d/01-wazo.conf <<EOF
[global]
type = global
user_agent = TwakePhone
; OpenSIPS's socket for Wazo is its address (ip): a mailbox's call. The lines' socket, another address of OpenSIPS
; (step 11c-1), is no match there: its requests are a line's, by their credentials or their From (auth_username,
; username), see the lines below.
endpoint_identifier_order = ip,auth_username,username

; What every line shares: the media as a browser's. Its context and its credentials are the line's, from wazo-confd.
[twake-line](!)
type = endpoint
transport = twake-transport
disallow = all
allow = opus,g722,alaw,ulaw
dtmf_mode = rfc4733
language = fr_FR
webrtc = yes
dtls_auto_generate_cert = yes
media_address = ${WAZO_RTP_ADDRESS}
bind_rtp_to_media_address = yes
direct_media = no
rtp_symmetric = yes
send_pai = no
trust_id_inbound = no

[twake-transport]
type = transport
protocol = udp
bind = ${WAZO_SIP_LISTEN}

[opensips]
type = aor
contact = sip:${WAZO_OPENSIPS}

[opensips]
type = identify
endpoint = opensips
match = ${opensips_ip}

[opensips]
type = endpoint
transport = twake-transport
aors = opensips
context = twake-opensips
disallow = all
allow = opus,g722,alaw,ulaw
dtmf_mode = rfc4733
language = fr_FR
webrtc = yes
dtls_auto_generate_cert = yes
media_address = ${WAZO_RTP_ADDRESS}
bind_rtp_to_media_address = yes
direct_media = no
rtp_symmetric = yes
send_pai = no
trust_id_inbound = no
EOF

# The lines (step 11c-1, ADR 0027): the endpoints, AORs and credentials wazo-confd has for the people (wazo-confgend's
# pjsip.conf), each endpoint made on the template above, without what else it writes (its transports listen on every
# address, its global and system sections are this stack's own).
cat > /usr/bin/twake-pjsip-lines <<'EOF'
#!/bin/bash
set -o pipefail
wazo-confgen asterisk/pjsip.conf | awk '
  function flush() {
    if (keep) {
      if (kind == "endpoint") sub(/\]$/, "](twake-line)", first)
      printf "%s\n%s", first, rest
    }
    first = ""; rest = ""; keep = 0; kind = ""
  }
  /^\[/ { flush(); first = $0; next }
  { rest = rest $0 "\n" }
  /^type[ \t]*=[ \t]*(endpoint|aor|auth)[ \t]*$/ { keep = 1; kind = $3 }
  END { flush() }'
EOF
chmod 755 /usr/bin/twake-pjsip-lines
printf '#exec /usr/bin/twake-pjsip-lines\n' > /etc/asterisk/pjsip.d/02-wazo-lines.conf

cat > /etc/asterisk/rtp.d/01-wazo.conf <<EOF
[general]
rtpstart = ${WAZO_RTP_MIN}
rtpend = ${WAZO_RTP_MAX}
icesupport = yes
EOF

# The AMI, on the loopback: wazo-amid's account, with this stack's password and the rights and filters Wazo gives it,
# and the account of this stack's wazo-sysconfd (docker/wazo/sysconfd.py): no event, and the
# privileges of the AMI actions it runs only, never `command` (the whole CLI): `system` for Reload,
# `reporting` for VoicemailUsersList. Asterisk has nothing finer for Reload: `system` also lets the account read any
# configuration file (GetConfig, GetConfigJSON: this one, with wazo-amid's password, included), load a module
# (ModuleLoad), hang up a channel (Hangup, AbsoluteTimeout) and add or remove a dialplan extension
# (DialplanExtensionAdd, DialplanExtensionRemove); it is refused Command, Originate and UpdateConfig (the
# e2e checks both against this Asterisk). A development and CI stack's only (ADR 0022): a real Wazo's
# wazo-sysconfd runs `asterisk -rx` on its machine, with no such account; its password is in the compose file, for
# any process on the loopback of the host. The image's
# manager.d/01-xivo.conf has wazo-amid's account with Wazo's public default password,
# read after this file (the last definition wins), and accounts of services this stack does not run: it goes.
rm -f /etc/asterisk/manager.d/01-xivo.conf
cat > /etc/asterisk/manager.d/01-wazo.conf <<EOF
[general]
enabled = yes
bindaddr = 127.0.0.1
port = 5038

[wazo_amid]
secret = ${WAZO_AMI_PASSWORD}
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read = system,call,agent,user,config,dialplan,dtmf
write = all
eventfilter = !Event: ExtensionStatus
eventfilter = !Event: Newexten
eventfilter = !Event: VarSet

[twake_sysconfd]
secret = ${WAZO_SYSCONFD_AMI_PASSWORD}
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read =
write = system,reporting

; The Gateway's (step 11d, ADR 0029; provider-wazo's WAZO_AMI_USER): two accounts, because Asterisk lets an account that
; holds both `system` and `originate` have Originate run any application (System included: a shell). The first holds
; `system` (MixMonitor, StopMixMonitor) and `reporting` (CoreShowChannels): it is refused Originate, `command` and
; `config`. The second holds `originate` alone, read `call` (the OriginateResponse it waits for): its Originate may run
; the applications Asterisk does not blacklist (Playback, ChanSpy: what this feature calls), never System, Exec or AGI.
; `system` still lets the first read any configuration file (GetConfig, this one included), hang up a channel and, with
; MixMonitor's `Command` header, run a command when a recording ends: the account is as trusted as the Gateway, a
; development and CI account on the loopback; on a Wazo, accounts of their own.
[twake_gateway]
secret = ${WAZO_GATEWAY_AMI_PASSWORD}
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read =
write = system,reporting

[twake_gateway_originate]
secret = ${WAZO_GATEWAY_ORIGINATE_PASSWORD}
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read = call
write = originate
EOF

# The HTTP server of ARI, on the loopback (the image's says so; written here so that nothing else decides it), and the
# ARI account of wazo-calld and wazo-confd with this stack's password, not Wazo's public default.
cat > /etc/asterisk/http.d/01-wazo.conf <<EOF
[general]
enabled = yes
bindaddr = 127.0.0.1
bindport = 5039
prefix =
servername = Wazo PBX
sessionlimit = 1000
EOF
sed -i -E "s/^password[[:space:]]*=.*/password = ${WAZO_ARI_PASSWORD}/" /etc/asterisk/ari.d/01-wazo.conf
grep -q "^password = ${WAZO_ARI_PASSWORD}\$" /etc/asterisk/ari.d/01-wazo.conf || { echo "the ARI account was not found in ari.d/01-wazo.conf" >&2; exit 1; }
# No call log of Asterisk's own (CDR, CEL, queue_log): neither in Wazo's database nor in a file. The image's CDR are
# off already; written here so that nothing else decides it.
cat > /etc/asterisk/cdr.d/01-wazo.conf <<EOF
[general]
enable = no
EOF
cat > /etc/asterisk/cel.d/01-wazo.conf <<EOF
[general]
enable = no
EOF
cat > /etc/asterisk/logger.d/01-wazo.conf <<EOF
[general]
dateformat = %F %T.%4q
queue_log = no

[logfiles]
console => notice,warning,error
EOF
# No trace of the dialplan to Docker's log (the image's asterisk.conf says verbose = 5): the number of a caller is in it.
sed -i -E 's/^verbose[[:space:]]*=.*/verbose = 0/' /etc/asterisk/asterisk.conf
grep -q '^verbose = 0$' /etc/asterisk/asterisk.conf || { echo "the verbosity was not found in asterisk.conf" >&2; exit 1; }

# Wazo's database, on the port of this stack, with its password: the image's odbc.ini names PostgreSQL's default port.
cat > /etc/odbc.ini <<EOF
[xivo]
Description = Connection to the database used by Wazo
Driver = PostgreSQL ANSI
Trace = No
Database = asterisk
Servername = ${WAZO_DB%:*}
Port = ${WAZO_DB#*:}
EOF
sed -i -E "s/^password[[:space:]]*=>.*/password => ${WAZO_DB_PASSWORD}/" /etc/asterisk/res_odbc.d/01-wazo.conf

# The mailboxes: wazo-calld reads them under its own account (www-data), as the files Asterisk makes are (0644).
install -d -o asterisk -g asterisk -m 0755 /var/spool/asterisk/voicemail
# The recordings (step 11d): <tenant>/monitor/<uuid>.wav, which MixMonitor makes and docker/wazo/recordings.py serves.
install -d -o asterisk -g asterisk -m 0755 /var/lib/wazo/sounds/tenants
# The dialplan reads it (TIMEOUT(absolute) of a call to a mailbox).
export VOICEMAIL_MAX_CALL_SEC
exec asterisk -f -U asterisk -G asterisk
