#!/bin/sh
# Renders opensips.cfg from the template and the environment, makes a throwaway certificate when none is given,
# then runs OpenSIPS in the foreground. Every variable has a value fit for a local or CI stack.
set -eu

: "${SIP_DOMAIN:=127.0.0.1}"
: "${LISTEN_IP:=127.0.0.1}"
: "${SIP_PORT:=5060}"
: "${WS_PORT:=8088}"
: "${WSS_PORT:=8089}"
: "${OPENSIPS_DB_URL:=postgres://twake:twake@127.0.0.1:54320/twake}"
: "${RTPENGINE_SOCK:=udp:127.0.0.1:22222}"
: "${OPENSIPS_LOG_LEVEL:=2}"
: "${OPENSIPS_MPATH:=/usr/lib/x86_64-linux-gnu/opensips/modules/}"
: "${MI_FIFO:=/tmp/opensips_fifo}"
: "${MI_LISTEN_IP:=127.0.0.1}"
: "${MI_PORT:=8880}"
: "${MI_ALLOW_PUBLIC:=0}"
: "${TLS_CERT:=/etc/opensips/tls/cert.pem}"
: "${TLS_KEY:=/etc/opensips/tls/key.pem}"
: "${CFG_TEMPLATE:=/etc/opensips/opensips.cfg.tpl}"
: "${CFG_OUT:=/etc/opensips/opensips.cfg}"
: "${OPENSIPS_BIN:=/usr/sbin/opensips}"
: "${TRUNK_SQL:=/etc/opensips/trunk.sql}"
# The trunk's UDP socket (step 6, ADR 0016): the address OpenSIPS registers to the operator and calls from, the
# loopback like LISTEN_IP by default (set the machine's own address to reach an operator), never port 5060 by default
# (ARCHITECTURE §13). TRUNK_ADVERTISE (host[:port]) only when the operator must be told another address: by default
# none is declared, the operator answers where the packets come from.
: "${TRUNK_LISTEN_IP:=$LISTEN_IP}"
: "${TRUNK_PORT:=5070}"
: "${TRUNK_ADVERTISE:=}"
# The longest a call with the operator lasts, in seconds: OpenSIPS then ends it with a BYE to both sides (a browser
# gone without one never leaves the operator's leg open longer). 4 hours by default.
: "${TRUNK_MAX_CALL_SEC:=14400}"
case "$TRUNK_MAX_CALL_SEC" in
  '' | *[!0-9]*) echo "TRUNK_MAX_CALL_SEC must be a number of seconds" >&2; exit 1 ;;
esac
if [ "$TRUNK_MAX_CALL_SEC" -lt 60 ] || [ "$TRUNK_MAX_CALL_SEC" -gt 86400 ]; then
  echo "TRUNK_MAX_CALL_SEC must be 60 to 86400 seconds" >&2; exit 1
fi
# The call rules are read at each INVITE (sqlops, ADR 0013): on their own connections, whose queries PostgreSQL stops
# after this many milliseconds (the call then goes on without rules), so that a slow database never holds a call.
: "${RULES_QUERY_TIMEOUT_MS:=1000}"
case "$RULES_QUERY_TIMEOUT_MS" in
  '' | *[!0-9]*) echo "RULES_QUERY_TIMEOUT_MS must be a number of milliseconds" >&2; exit 1 ;;
esac
# How long a call to someone without a window waits for a browser of theirs to wake (step 5, ADR 0015), in seconds,
# when they have no no-answer forward (whose delay it is otherwise).
: "${PUSH_WAIT_SEC:=30}"
case "$PUSH_WAIT_SEC" in
  '' | *[!0-9]*) echo "PUSH_WAIT_SEC must be a number of seconds" >&2; exit 1 ;;
esac
if [ "$PUSH_WAIT_SEC" -lt 5 ] || [ "$PUSH_WAIT_SEC" -gt 120 ]; then
  echo "PUSH_WAIT_SEC must be 5 to 120 seconds" >&2; exit 1
fi
# The parameters of the URL follow the host: a "?" in the password (OpenSIPS ends it at the "@") is not one.
case "${OPENSIPS_DB_URL##*@}" in
  *\?options=* | *\&options=*)
    # Its own server options: kept as they are (a second options= would replace them), so they must bound the reads.
    OPENSIPS_RULES_DB_URL="$OPENSIPS_DB_URL"
    echo "OPENSIPS_DB_URL sets options: RULES_QUERY_TIMEOUT_MS is not applied, add -cstatement_timeout to them" >&2 ;;
  *\?*) OPENSIPS_RULES_DB_URL="${OPENSIPS_DB_URL}&options=-cstatement_timeout=${RULES_QUERY_TIMEOUT_MS}" ;;
  *) OPENSIPS_RULES_DB_URL="${OPENSIPS_DB_URL}?options=-cstatement_timeout=${RULES_QUERY_TIMEOUT_MS}" ;;
esac
case "$TRUNK_PORT" in
  '' | *[!0-9]*) echo "TRUNK_PORT must be a port number" >&2; exit 1 ;;
esac
if [ "$TRUNK_PORT" -lt 1 ] || [ "$TRUNK_PORT" -gt 65535 ]; then
  echo "TRUNK_PORT must be 1 to 65535" >&2; exit 1
fi
if [ "$TRUNK_LISTEN_IP" = "$LISTEN_IP" ] && [ "$TRUNK_PORT" = "$SIP_PORT" ]; then
  echo "TRUNK_PORT must differ from SIP_PORT on the same address: the trunk has a socket of its own" >&2; exit 1
fi
# A name or an IPv4 address, as the trunk socket (an IPv6 one has more than one colon).
case "$TRUNK_ADVERTISE" in
  *[!A-Za-z0-9.:-]* | *:*:* | :* | *:) echo "TRUNK_ADVERTISE must be host or host:port" >&2; exit 1 ;;
  '') TRUNK_SOCKET_AS='' ;;
  *) TRUNK_SOCKET_AS=" as $TRUNK_ADVERTISE" ;;
esac
export SIP_DOMAIN LISTEN_IP SIP_PORT WS_PORT WSS_PORT OPENSIPS_DB_URL OPENSIPS_RULES_DB_URL PUSH_WAIT_SEC RTPENGINE_SOCK OPENSIPS_LOG_LEVEL OPENSIPS_MPATH MI_FIFO MI_LISTEN_IP MI_PORT TLS_CERT TLS_KEY TRUNK_LISTEN_IP TRUNK_PORT TRUNK_SOCKET_AS TRUNK_MAX_CALL_SEC

# The MI socket (mi_datagram) has no authentication: whoever reaches it can stop OpenSIPS, drop registrations, end
# calls, read who is registered and subscribe to the events (who calls whom). It listens on its own address, the
# loopback by default, never on LISTEN_IP because SIP is opened to a network: a private address (the Gateway on
# another host of an internal network) is accepted, any other one only with MI_ALLOW_PUBLIC=1.
# A dotted IPv4 address: four numbers from 0 to 255, nothing else.
is_ipv4() {
  case "$1" in
    '' | *[!0-9.]* | .* | *. | *..*) return 1 ;;
  esac
  saved_ifs=$IFS
  IFS=.
  # Split on the dots (no glob character can be left after the check above).
  # shellcheck disable=SC2086
  set -- $1
  IFS=$saved_ifs
  [ "$#" -eq 4 ] || return 1
  for octet in "$@"; do
    case "$octet" in
      ? | ?? | ???) ;;
      *) return 1 ;;
    esac
    [ "$octet" -le 255 ] || return 1
  done
}
mi_address_is_private() {
  is_ipv4 "$1" || return 1
  case "$1" in
    127.* | 10.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].* | 169.254.*) return 0 ;;
    *) return 1 ;;
  esac
}
# The trunk socket is a real address of the machine: OpenSIPS registers it with the operator.
if ! is_ipv4 "$TRUNK_LISTEN_IP" || [ "$TRUNK_LISTEN_IP" = "0.0.0.0" ]; then
  echo "TRUNK_LISTEN_IP=$TRUNK_LISTEN_IP must be an IPv4 address of this machine (not 0.0.0.0)" >&2; exit 1
fi
if ! mi_address_is_private "$MI_LISTEN_IP" && [ "$MI_ALLOW_PUBLIC" != "1" ]; then
  echo "MI_LISTEN_IP=$MI_LISTEN_IP is not a loopback or private IPv4 address: the MI has no authentication." >&2
  echo "Keep it on 127.0.0.1 (or the private network the Gateway reaches it on), or set MI_ALLOW_PUBLIC=1 behind a firewall." >&2
  exit 1
fi

if [ ! -f "$TLS_CERT" ] || [ ! -f "$TLS_KEY" ]; then
  echo "No certificate at $TLS_CERT: making a self-signed one for $SIP_DOMAIN (dev and CI only)" >&2
  mkdir -p "$(dirname "$TLS_CERT")" "$(dirname "$TLS_KEY")"
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=$SIP_DOMAIN" \
    -addext "subjectAltName=DNS:$SIP_DOMAIN,DNS:localhost,IP:127.0.0.1" \
    -keyout "$TLS_KEY" -out "$TLS_CERT" 2>/dev/null
fi

# Only the listed variables are substituted: a "$avp(...)" of the script must stay as it is.
envsubst '$SIP_DOMAIN $LISTEN_IP $SIP_PORT $WS_PORT $WSS_PORT $OPENSIPS_DB_URL $OPENSIPS_RULES_DB_URL $PUSH_WAIT_SEC $RTPENGINE_SOCK $OPENSIPS_LOG_LEVEL $OPENSIPS_MPATH $MI_FIFO $MI_LISTEN_IP $MI_PORT $TLS_CERT $TLS_KEY $TRUNK_LISTEN_IP $TRUNK_PORT $TRUNK_SOCKET_AS $TRUNK_MAX_CALL_SEC' \
  < "$CFG_TEMPLATE" > "$CFG_OUT"

# The tables of the trunks (step 6): dispatcher, dialplan and uac_registrant read theirs at start and OpenSIPS stops
# without them; a database created before step 6 has none. Created when missing, with the numbering plan of this
# version (trunk.sql, generated from provider-opensips), tried for a minute while the database comes up.
if [ -f "$TRUNK_SQL" ]; then
  tries=0
  until PGOPTIONS="-c client_min_messages=warning" psql "$OPENSIPS_DB_URL" -v ON_ERROR_STOP=1 -q -f "$TRUNK_SQL" >/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -ge 30 ]; then
      echo "The tables of the trunks could not be written into the database of OPENSIPS_DB_URL" >&2; exit 1
    fi
    sleep 2
  done
fi
"$OPENSIPS_BIN" -C -f "$CFG_OUT"
exec "$OPENSIPS_BIN" -F -f "$CFG_OUT" "$@"
