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
# The longest a call with the operator lasts, in seconds: OpenSIPS then ends it with a BYE to both sides (a bound on
# what the operator charges, whatever the phones do). An emergency call is never cut. 4 hours by default.
: "${TRUNK_MAX_CALL_SEC:=14400}"
case "$TRUNK_MAX_CALL_SEC" in
  '' | *[!0-9]*) echo "TRUNK_MAX_CALL_SEC must be a number of seconds" >&2; exit 1 ;;
esac
if [ "$TRUNK_MAX_CALL_SEC" -lt 60 ] || [ "$TRUNK_MAX_CALL_SEC" -gt 86400 ]; then
  echo "TRUNK_MAX_CALL_SEC must be 60 to 86400 seconds" >&2; exit 1
fi
# The shortest a call to the public network may be allotted under a minute cap (step 6b, ADR 0017): with less left
# (shared between the calls that may still be placed at once), it is refused rather than charged its first unit and
# cut. In seconds, 60 by default.
: "${TRUNK_MIN_CALL_SEC:=60}"
case "$TRUNK_MIN_CALL_SEC" in
  '' | *[!0-9]*) echo "TRUNK_MIN_CALL_SEC must be a number of seconds" >&2; exit 1 ;;
esac
if [ "$TRUNK_MIN_CALL_SEC" -lt 1 ] || [ "$TRUNK_MIN_CALL_SEC" -gt 600 ]; then
  echo "TRUNK_MIN_CALL_SEC must be 1 to 600 seconds" >&2; exit 1
fi
# The days and months of the caps are those of Europe/Paris whatever the clock (SQL); OpenSIPS's own (its logs, the
# day of fraud_detection's daily counters) too unless TZ says otherwise.
: "${TZ:=Europe/Paris}"
# How often the phone of a call with the operator is asked whether it is still there (an OPTIONS in the dialog), and
# how long it has to answer: one that does not answer within CALL_PING_TIMEOUT_SEC (put to sleep, its page closed or
# reloaded, its network gone) has the call ended, a BYE to the operator; a shorter silence (a network that switches)
# keeps it. A phone gone is noticed within CALL_PING_SEC + CALL_PING_TIMEOUT_SEC. Never an emergency call. In
# seconds, 30 and 15 by default.
: "${CALL_PING_SEC:=30}"
case "$CALL_PING_SEC" in
  '' | *[!0-9]*) echo "CALL_PING_SEC must be a number of seconds" >&2; exit 1 ;;
esac
if [ "$CALL_PING_SEC" -lt 5 ] || [ "$CALL_PING_SEC" -gt 300 ]; then
  echo "CALL_PING_SEC must be 5 to 300 seconds" >&2; exit 1
fi
: "${CALL_PING_TIMEOUT_SEC:=15}"
case "$CALL_PING_TIMEOUT_SEC" in
  '' | *[!0-9]*) echo "CALL_PING_TIMEOUT_SEC must be a number of seconds" >&2; exit 1 ;;
esac
if [ "$CALL_PING_TIMEOUT_SEC" -lt 5 ] || [ "$CALL_PING_TIMEOUT_SEC" -gt 60 ]; then
  echo "CALL_PING_TIMEOUT_SEC must be 5 to 60 seconds" >&2; exit 1
fi
# The call rules are read at each INVITE (sqlops, ADR 0013): on their own connections, whose queries PostgreSQL stops
# after this many milliseconds (the call then goes on without rules), so that a slow database never holds a call.
: "${RULES_QUERY_TIMEOUT_MS:=1000}"
case "$RULES_QUERY_TIMEOUT_MS" in
  '' | *[!0-9]*) echo "RULES_QUERY_TIMEOUT_MS must be a number of milliseconds" >&2; exit 1 ;;
esac
# The database connections of each SIP process for its asynchronous reads (review 8b, n°5): past them, OpenSIPS 3.6
# drops what a read returns. Ten SIP processes on this configuration: the database must take ten times as many, and more.
: "${DB_MAX_ASYNC_CONNECTIONS:=8}"
case "$DB_MAX_ASYNC_CONNECTIONS" in
  '' | *[!0-9]*) echo "DB_MAX_ASYNC_CONNECTIONS must be a number" >&2; exit 1 ;;
esac
if [ "$DB_MAX_ASYNC_CONNECTIONS" -lt 1 ] || [ "$DB_MAX_ASYNC_CONNECTIONS" -gt 32 ]; then
  echo "DB_MAX_ASYNC_CONNECTIONS must be 1 to 32" >&2; exit 1
fi
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
# The phone access of Meet's rooms (step 8, ADR 0018): LiveKit SIP, at MEET_SIP (an IPv4 address and its port), sees
# no other trunk than OpenSIPS, on a UDP socket of its own (MEET_LISTEN_IP:MEET_PORT, the loopback and 5090 by
# default), which hears its address only. A call to MEET_NUMBER (8000 by default) goes to it, which asks for a room's
# PIN; a call it places for a room answers OpenSIPS's challenge with MEET_SIP_USER and MEET_SIP_PASSWORD (the same as
# the Gateway gives LiveKit's outbound trunk: only their HA1 is in the configuration), and only with the Gateway's
# grant of that very call (route[meet_source]). MEET_SIP empty (the default): Meet is off, OpenSIPS has no socket for
# it at all and MEET_NUMBER is nobody's. A call to MEET_NUMBER that LiveKit SIP answers is one try of a PIN
# (LiveKit SIP takes one per call), whatever happens in it. MEET_PIN_TRIES: the tries after which a caller is refused
# for the rest of 10 minutes, 10 by default (1 to 1000); MEET_PIN_TRIES_ALL: those of all callers together in 10
# minutes that tell the administrators, 300 by default (and the cap of those who hide their number, who share one
# count). MEET_CALLS_PER_CALLER: the calls of one caller to MEET_NUMBER at the same time, 2 by default (1 to 20);
# MEET_CALLS_ALL: those of all callers, 100 by default (MEET_CALLS_PER_CALLER to 10000), refused past it and told to
# the administrators. MEET_MAX_CALL_SEC: the longest a call with LiveKit SIP
# lasts, either way (7200 s by default, 60 to 86400, never more than TRUNK_MAX_CALL_SEC): LiveKit SIP answers any
# OPTIONS, so a LiveKit SIP gone in the middle of the call is only noticed then.
: "${MEET_SIP:=}"
: "${MEET_LISTEN_IP:=127.0.0.1}"
: "${MEET_PORT:=5090}"
: "${MEET_NUMBER:=8000}"
: "${MEET_SIP_USER:=livekit}"
: "${MEET_SIP_PASSWORD:=}"
# The settings of Meet's phone access, read only when it is on (MEET_SIP): the defaults otherwise, whatever is set.
if [ -n "$MEET_SIP" ]; then
  : "${MEET_PIN_TRIES:=10}"
  : "${MEET_PIN_TRIES_ALL:=300}"
  : "${MEET_CALLS_PER_CALLER:=2}"
  : "${MEET_CALLS_ALL:=100}"
  : "${MEET_MAX_CALL_SEC:=7200}"
  case "$MEET_PIN_TRIES" in
    '' | *[!0-9]*) echo "MEET_PIN_TRIES must be a number of tries" >&2; exit 1 ;;
  esac
  if [ "$MEET_PIN_TRIES" -lt 1 ] || [ "$MEET_PIN_TRIES" -gt 1000 ]; then
    echo "MEET_PIN_TRIES must be 1 to 1000 tries" >&2; exit 1
  fi
  case "$MEET_PIN_TRIES_ALL" in
    '' | *[!0-9]*) echo "MEET_PIN_TRIES_ALL must be a number of tries" >&2; exit 1 ;;
  esac
  if [ "$MEET_PIN_TRIES_ALL" -lt "$MEET_PIN_TRIES" ] || [ "$MEET_PIN_TRIES_ALL" -gt 100000 ]; then
    echo "MEET_PIN_TRIES_ALL must be MEET_PIN_TRIES to 100000 tries" >&2; exit 1
  fi
  case "$MEET_CALLS_PER_CALLER" in
    '' | *[!0-9]*) echo "MEET_CALLS_PER_CALLER must be a number of calls" >&2; exit 1 ;;
  esac
  if [ "$MEET_CALLS_PER_CALLER" -lt 1 ] || [ "$MEET_CALLS_PER_CALLER" -gt 20 ]; then
    echo "MEET_CALLS_PER_CALLER must be 1 to 20 calls" >&2; exit 1
  fi
  case "$MEET_CALLS_ALL" in
    '' | *[!0-9]*) echo "MEET_CALLS_ALL must be a number of calls" >&2; exit 1 ;;
  esac
  if [ "$MEET_CALLS_ALL" -lt "$MEET_CALLS_PER_CALLER" ] || [ "$MEET_CALLS_ALL" -gt 10000 ]; then
    echo "MEET_CALLS_ALL must be MEET_CALLS_PER_CALLER to 10000 calls" >&2; exit 1
  fi
  case "$MEET_MAX_CALL_SEC" in
    '' | *[!0-9]*) echo "MEET_MAX_CALL_SEC must be a number of seconds" >&2; exit 1 ;;
  esac
  if [ "$MEET_MAX_CALL_SEC" -lt 60 ] || [ "$MEET_MAX_CALL_SEC" -gt 86400 ]; then
    echo "MEET_MAX_CALL_SEC must be 60 to 86400 seconds" >&2; exit 1
  fi
else
  MEET_PIN_TRIES=10
  MEET_PIN_TRIES_ALL=300
  MEET_CALLS_PER_CALLER=2
  MEET_CALLS_ALL=100
  MEET_MAX_CALL_SEC=7200
fi
case "$MEET_PORT" in
  '' | *[!0-9]*) echo "MEET_PORT must be a port number" >&2; exit 1 ;;
esac
if [ "$MEET_PORT" -lt 1 ] || [ "$MEET_PORT" -gt 65535 ]; then
  echo "MEET_PORT must be 1 to 65535" >&2; exit 1
fi
if { [ "$MEET_LISTEN_IP" = "$LISTEN_IP" ] && [ "$MEET_PORT" = "$SIP_PORT" ]; } || { [ "$MEET_LISTEN_IP" = "$TRUNK_LISTEN_IP" ] && [ "$MEET_PORT" = "$TRUNK_PORT" ]; }; then
  echo "MEET_PORT must differ from SIP_PORT and TRUNK_PORT on the same address: LiveKit SIP has a socket of its own" >&2; exit 1
fi
# An extension's format (the Gateway's): two to six digits, not starting with 0.
case "$MEET_NUMBER" in
  [1-9][0-9] | [1-9][0-9][0-9] | [1-9][0-9][0-9][0-9] | [1-9][0-9][0-9][0-9][0-9] | [1-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *) echo "MEET_NUMBER must be two to six digits, not starting with 0" >&2; exit 1 ;;
esac
case "$MEET_SIP_USER" in
  '' | *[!A-Za-z0-9._-]*) echo "MEET_SIP_USER must be letters, digits, dots, dashes or underscores" >&2; exit 1 ;;
esac
MEET_ON=0
MEET_SIP_IP=''
MEET_SIP_HA1=''
MEET_SOCKET='# None: Meet is off (MEET_SIP empty).'
if [ -n "$MEET_SIP" ]; then
  MEET_ON=1
  MEET_SOCKET="socket=udp:$MEET_LISTEN_IP:$MEET_PORT"
  MEET_SIP_IP=${MEET_SIP%:*}
  meet_sip_port=${MEET_SIP##*:}
  case "$meet_sip_port" in
    '' | *[!0-9]*) echo "MEET_SIP must be LiveKit SIP's IPv4 address and port (192.0.2.20:5080)" >&2; exit 1 ;;
  esac
  if [ "$MEET_SIP_IP" = "$MEET_SIP" ] || [ "$meet_sip_port" -lt 1 ] || [ "$meet_sip_port" -gt 65535 ]; then
    echo "MEET_SIP must be LiveKit SIP's IPv4 address and port (192.0.2.20:5080)" >&2; exit 1
  fi
  if [ "${#MEET_SIP_PASSWORD}" -lt 12 ]; then
    echo "MEET_SIP_PASSWORD (12 characters at least) is needed with MEET_SIP: LiveKit SIP's calls must answer a challenge" >&2; exit 1
  fi
  MEET_SIP_HA1=$(printf '%s' "$MEET_SIP_USER:$SIP_DOMAIN:$MEET_SIP_PASSWORD" | md5sum | cut -c1-32)
else
  # Never reached (MEET_ON 0), still a valid URI.
  MEET_SIP=meet.invalid
fi
unset MEET_SIP_PASSWORD
export SIP_DOMAIN LISTEN_IP SIP_PORT WS_PORT WSS_PORT OPENSIPS_DB_URL OPENSIPS_RULES_DB_URL RULES_QUERY_TIMEOUT_MS DB_MAX_ASYNC_CONNECTIONS PUSH_WAIT_SEC RTPENGINE_SOCK OPENSIPS_LOG_LEVEL OPENSIPS_MPATH MI_FIFO MI_LISTEN_IP MI_PORT TLS_CERT TLS_KEY TRUNK_LISTEN_IP TRUNK_PORT TRUNK_SOCKET_AS TRUNK_MAX_CALL_SEC TRUNK_MIN_CALL_SEC CALL_PING_SEC CALL_PING_TIMEOUT_SEC TZ MEET_ON MEET_SIP MEET_SIP_IP MEET_LISTEN_IP MEET_PORT MEET_NUMBER MEET_SIP_USER MEET_SIP_HA1 MEET_SOCKET MEET_PIN_TRIES MEET_PIN_TRIES_ALL MEET_CALLS_PER_CALLER MEET_CALLS_ALL MEET_MAX_CALL_SEC

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
if ! is_ipv4 "$MEET_LISTEN_IP" || [ "$MEET_LISTEN_IP" = "0.0.0.0" ]; then
  echo "MEET_LISTEN_IP=$MEET_LISTEN_IP must be an IPv4 address of this machine (not 0.0.0.0)" >&2; exit 1
fi
if [ "$MEET_ON" = 1 ] && { ! is_ipv4 "$MEET_SIP_IP" || [ "$MEET_SIP_IP" = "0.0.0.0" ]; }; then
  echo "MEET_SIP must be LiveKit SIP's IPv4 address and port (192.0.2.20:5080)" >&2; exit 1
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
envsubst '$SIP_DOMAIN $LISTEN_IP $SIP_PORT $WS_PORT $WSS_PORT $OPENSIPS_DB_URL $OPENSIPS_RULES_DB_URL $RULES_QUERY_TIMEOUT_MS $DB_MAX_ASYNC_CONNECTIONS $PUSH_WAIT_SEC $RTPENGINE_SOCK $OPENSIPS_LOG_LEVEL $OPENSIPS_MPATH $MI_FIFO $MI_LISTEN_IP $MI_PORT $TLS_CERT $TLS_KEY $TRUNK_LISTEN_IP $TRUNK_PORT $TRUNK_SOCKET_AS $TRUNK_MAX_CALL_SEC $TRUNK_MIN_CALL_SEC $CALL_PING_SEC $CALL_PING_TIMEOUT_SEC $MEET_ON $MEET_SIP $MEET_SIP_IP $MEET_LISTEN_IP $MEET_PORT $MEET_NUMBER $MEET_SIP_USER $MEET_SIP_HA1 $MEET_SOCKET $MEET_PIN_TRIES $MEET_PIN_TRIES_ALL $MEET_CALLS_PER_CALLER $MEET_CALLS_ALL $MEET_MAX_CALL_SEC' \
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
  # Before any call (step 6b, second review n°4 and n°10): the minutes reserved for the calls a crash lost (one that
  # was ringing then is in no row of `dialog`) are released, the emergency calls OpenSIPS restores end within 2 h at
  # most (their phone is never asked whether it is still there), and what CDRs could not count is counted. A failure
  # only leaves the reservations to their expiry: OpenSIPS starts all the same.
  PGOPTIONS="-c client_min_messages=warning" psql "$OPENSIPS_DB_URL" -v ON_ERROR_STOP=1 -qAt -c "SELECT twake_outbound_restart(7200)" \
    || echo "The calls lost at the last stop could not be cleared from the database of OPENSIPS_DB_URL" >&2
fi
"$OPENSIPS_BIN" -C -f "$CFG_OUT"
exec "$OPENSIPS_BIN" -F -f "$CFG_OUT" "$@"
