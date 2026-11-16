#!/bin/sh
# OpenSIPS for the load bench: the stack's own entrypoint, on a copy of the script with the TCP connection limit
# raised (it is not set in opensips.cfg.tpl: the default of OpenSIPS, 2048, applies). The shared memory comes from `-m`,
# given by the compose override (command). The script of the stack is not changed.
set -eu
sed 's/^tcp_workers=4$/tcp_workers=4\ntcp_max_connections=16384/' /etc/opensips/opensips.cfg.tpl > /tmp/opensips.bench.tpl
grep -q '^tcp_max_connections=16384$' /tmp/opensips.bench.tpl
CFG_TEMPLATE=/tmp/opensips.bench.tpl exec /usr/local/bin/twakephone-opensips "$@"
