#!/bin/sh
# rtpengine in the foreground, user-space forwarding, control socket for OpenSIPS on RTPENGINE_LISTEN.
# RTPENGINE_INTERFACE is the address written in the SDP (what the browsers must reach): the host's address on a
# host-network stack, or "<private>!<public>" behind a NAT.
set -eu
: "${RTPENGINE_INTERFACE:=127.0.0.1}"
: "${RTPENGINE_LISTEN:=127.0.0.1:22222}"
: "${RTPENGINE_PORT_MIN:=30000}"
: "${RTPENGINE_PORT_MAX:=30100}"
: "${RTPENGINE_LOG_LEVEL:=5}"
# Where detected RFC 4733 tones are reported (JSON over UDP), for the e2e; empty disables it.
: "${RTPENGINE_DTMF_LOG:=}"
exec rtpengine --foreground --log-stderr --no-fallback --table=-1 \
  --interface="$RTPENGINE_INTERFACE" --listen-ng="$RTPENGINE_LISTEN" \
  --port-min="$RTPENGINE_PORT_MIN" --port-max="$RTPENGINE_PORT_MAX" --log-level="$RTPENGINE_LOG_LEVEL" ${RTPENGINE_DTMF_LOG:+--dtmf-log-dest="$RTPENGINE_DTMF_LOG"} "$@"
