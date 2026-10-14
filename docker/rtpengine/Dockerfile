# rtpengine (Sipwise, GPLv3) from the Ubuntu 24.04 packages, in user-space mode: enough for development and CI.
# Production loads the xt_RTPENGINE kernel module for in-kernel forwarding (the daemon is the same).
FROM ubuntu:24.04
RUN apt-get -y update -qq && apt-get -y install --no-install-recommends rtpengine \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /usr/local/bin/twakephone-rtpengine
ENTRYPOINT ["/usr/local/bin/twakephone-rtpengine"]
