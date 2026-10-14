# OpenSIPS 3.6 for TwakePhone: the official image plus the modules the configuration loads and the base package
# does not carry (proto_wss, tls_mgm, tls_openssl, db_postgres; package names from OpenSIPS's packaging/debian/rules).
# The configuration is rendered at start by entrypoint.sh.
FROM opensips/opensips:3.6
RUN apt-get -y update -qq && apt-get -y install --no-install-recommends \
      opensips-wss-module opensips-tlsmgm-module opensips-tls-openssl-module opensips-postgres-module gettext-base openssl \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && for m in proto_ws proto_wss tls_mgm tls_openssl db_postgres auth_db usrloc registrar nathelper dialog rtpengine; do \
         test -f "/usr/lib/x86_64-linux-gnu/opensips/modules/$m.so" || { echo "module $m missing" >&2; exit 1; }; \
       done
COPY opensips.cfg.tpl /etc/opensips/opensips.cfg.tpl
COPY entrypoint.sh /usr/local/bin/twakephone-opensips
ENTRYPOINT ["/usr/local/bin/twakephone-opensips"]
