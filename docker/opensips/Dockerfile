# OpenSIPS 3.6 for TwakePhone: the official image plus the modules the configuration loads and the base package
# does not carry (proto_wss, tls_mgm, tls_openssl, db_postgres, auth and uac_auth, dialplan; package names from OpenSIPS's
# packaging/debian/rules), and psql, with which entrypoint.sh creates the tables of the trunks (trunk.sql) before the
# start. The configuration is rendered at start by entrypoint.sh.
FROM opensips/opensips:3.6
COPY opensips.cfg.tpl /etc/opensips/opensips.cfg.tpl
COPY trunk.sql /etc/opensips/trunk.sql
# Every module the template loads must exist in the image, or the build fails here rather than at start
# (proto_udp and proto_tcp are part of the core in 3.x: no .so, their loadmodule is accepted for compatibility).
RUN apt-get -y update -qq && apt-get -y install --no-install-recommends \
      opensips-wss-module opensips-tlsmgm-module opensips-tls-openssl-module opensips-postgres-module opensips-auth-modules opensips-dialplan-module postgresql-client gettext-base openssl \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && for m in $(sed -n 's/^loadmodule "\(.*\)\.so"/\1/p' /etc/opensips/opensips.cfg.tpl | grep -v '^proto_\(udp\|tcp\)$'); do \
         test -f "/usr/lib/x86_64-linux-gnu/opensips/modules/$m.so" || { echo "module $m missing" >&2; exit 1; }; \
       done
COPY entrypoint.sh /usr/local/bin/twakephone-opensips
ENTRYPOINT ["/usr/local/bin/twakephone-opensips"]
