#!/bin/bash
# Asterisk of Wazo (wazoplatform/asterisk, ADR 0022) for the development and CI stack: Wazo's own configuration, with
# what this stack replaces. Wazo's packaging includes every file of /etc/asterisk/*.d; the files written here take the
# place of Wazo's for the SIP side (a single trunk, OpenSIPS's socket for Wazo), the media and the dialplan (calls
# OpenSIPS sends to a mailbox), and add the AMI account of wazo-amid. The voicemails come from Wazo's database through
# wazo-confgend (voicemail.d/01-wazo.conf of the image), as on a Wazo; so does modules.conf, read once here.
#
#   WAZO_SIP_LISTEN    where Asterisk takes SIP (ip:port, UDP; 127.0.0.1:5100 by default)
#   WAZO_OPENSIPS      OpenSIPS's socket for Wazo (ip:port, its WAZO_LISTEN_IP:WAZO_PORT): the only party it hears
#   WAZO_RTP_ADDRESS   the address of its media (127.0.0.1 by default), WAZO_RTP_MIN and WAZO_RTP_MAX its UDP ports
#   WAZO_CONFGEND      wazo-confgend (ip:port, 127.0.0.1:8669 by default)
#   WAZO_AMI_PASSWORD  the password of wazo-amid's AMI account (this stack's own, as in wazo-amid's configuration)
#   WAZO_ARI_PASSWORD  the password of the ARI account of wazo-calld and wazo-confd (this stack's own, as in theirs)
#   WAZO_DB            Wazo's database (ip:port, 127.0.0.1:54330 by default), WAZO_DB_PASSWORD its password
#   VOICEMAIL_MAX_CALL_SEC
#                      the longest a call to a mailbox lasts, Asterisk's side (300 s by default, OpenSIPS's too)
#
# Everything it listens on is on the loopback (review 11a, n°4: docker/wazo/check-loopback.py says so in CI): SIP and
# its media where they are told, the AMI and the HTTP server of ARI (127.0.0.1:5039), and no channel or service this
# stack does not use (IAX2, SCCP, DUNDi). One socket only is on every address, which this Asterisk always makes: the
# DNS client of PJSIP (an ephemeral port that takes the answers to its own queries; it makes none here, every address
# being an IP). It keeps no call log of its own (CEL, queue_log: review 11a, n°10): the history of the calls is the
# Gateway's.
set -euo pipefail
: "${WAZO_SIP_LISTEN:=127.0.0.1:5100}"
: "${WAZO_OPENSIPS:=127.0.0.1:5095}"
: "${WAZO_RTP_ADDRESS:=127.0.0.1}"
: "${WAZO_RTP_MIN:=32000}"
: "${WAZO_RTP_MAX:=32100}"
: "${WAZO_CONFGEND:=127.0.0.1:8669}"
: "${WAZO_AMI_PASSWORD:=twake-wazo-dev-only-ami}"
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
for v in WAZO_AMI_PASSWORD WAZO_ARI_PASSWORD WAZO_DB_PASSWORD; do
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
user_agent = Wazo
endpoint_identifier_order = ip

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

cat > /etc/asterisk/rtp.d/01-wazo.conf <<EOF
[general]
rtpstart = ${WAZO_RTP_MIN}
rtpend = ${WAZO_RTP_MAX}
icesupport = yes
EOF

# The AMI, on the loopback: wazo-amid's account only, with this stack's password and the rights and filters Wazo gives
# it. The image's manager.d/01-xivo.conf has that account with Wazo's public default password, read after this file
# (the last definition wins), and accounts of services this stack does not run: it goes.
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
# No call log of Asterisk's own (CEL, queue_log): neither in Wazo's database nor in a file.
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
# The dialplan reads it (TIMEOUT(absolute) of a call to a mailbox).
export VOICEMAIL_MAX_CALL_SEC
exec asterisk -f -U asterisk -G asterisk -vvv
