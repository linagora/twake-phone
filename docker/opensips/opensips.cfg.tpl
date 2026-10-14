####### TwakePhone: OpenSIPS 3.6 for the web MVP (step 3) ##############################################################
# Rendered by entrypoint.sh from the environment (${VAR}). Registrar of the browsers (SIP over WS and WSS), digest
# authentication on the `subscriber` table the Gateway fills, calls between registered users through rtpengine
# (DTLS-SRTP on both legs), hold by re-INVITE. Trunk, forwards, groups and events towards the Gateway come with
# steps 4 and 6. Everything in here is OpenSIPS-specific; the Gateway only knows `provider-opensips`.

log_level=${OPENSIPS_LOG_LEVEL}
xlog_level=${OPENSIPS_LOG_LEVEL}
stderror_enabled=yes
syslog_enabled=no

udp_workers=2
tcp_workers=4
# A browser's WebSocket stays open as long as its registration (tcp_persistent_flag below).
tcp_connection_lifetime=3605

auto_aliases=no
# The SIP domain is "us" on our ports only: on a local stack it is also the browsers' address (127.0.0.1), and a
# port-less alias would make a browser's fixed Contact (127.0.0.1:<any port>) look like ours (strict routing).
alias="${SIP_DOMAIN}:${SIP_PORT}"
alias="${SIP_DOMAIN}:${WS_PORT}"
alias="${SIP_DOMAIN}:${WSS_PORT}"

# Advertised as SIP_DOMAIN: that is what Via and Record-Route carry, never a wildcard listen address.
socket=udp:${LISTEN_IP}:${SIP_PORT} as ${SIP_DOMAIN}:${SIP_PORT}
socket=ws:${LISTEN_IP}:${WS_PORT} as ${SIP_DOMAIN}:${WS_PORT}
socket=wss:${LISTEN_IP}:${WSS_PORT} as ${SIP_DOMAIN}:${WSS_PORT}

mpath="${OPENSIPS_MPATH}"

#### Transport
loadmodule "proto_udp.so"
loadmodule "proto_ws.so"
loadmodule "tls_openssl.so"
loadmodule "tls_mgm.so"
loadmodule "proto_wss.so"

# One TLS server domain for every WSS connection. The certificate is public in production (a prerequisite of the
# deployment), self-signed on a dev or CI stack (entrypoint.sh makes one). Clients are not asked for a certificate.
modparam("tls_mgm", "server_domain", "wss")
modparam("tls_mgm", "match_ip_address", "[wss]*")
modparam("tls_mgm", "match_sip_domain", "[wss]*")
modparam("tls_mgm", "certificate", "[wss]${TLS_CERT}")
modparam("tls_mgm", "private_key", "[wss]${TLS_KEY}")
modparam("tls_mgm", "tls_method", "[wss]TLSv1_2-")
modparam("tls_mgm", "verify_cert", "[wss]0")
modparam("tls_mgm", "require_cert", "[wss]0")

#### Core SIP
loadmodule "signaling.so"
loadmodule "sl.so"
loadmodule "tm.so"
modparam("tm", "fr_timeout", 5)
modparam("tm", "fr_inv_timeout", 60)
modparam("tm", "restart_fr_on_each_reply", 0)
modparam("tm", "onreply_avp_mode", 1)
loadmodule "rr.so"
modparam("rr", "append_fromtag", 1)
loadmodule "maxfwd.so"
loadmodule "sipmsgops.so"
loadmodule "mi_fifo.so"
modparam("mi_fifo", "fifo_name", "${MI_FIFO}")
modparam("mi_fifo", "fifo_mode", 0666)

#### Accounts: digest hashes written by the Gateway (provider-opensips) in `subscriber`
loadmodule "db_postgres.so"
loadmodule "auth.so"
loadmodule "auth_db.so"
modparam("auth_db", "db_url", "${OPENSIPS_DB_URL}")
modparam("auth_db", "calculate_ha1", 0)
modparam("auth_db", "password_column", "ha1")
modparam("auth_db", "use_domain", 0)
# Only the hash is read: no extra column (rpid and the like) is loaded into AVPs.
modparam("auth_db", "load_credentials", "")

#### Registrations: in memory, one node (clustering is a V1 exploitation item)
loadmodule "usrloc.so"
modparam("usrloc", "nat_bflag", "NAT")
modparam("usrloc", "working_mode_preset", "single-instance-no-db")
loadmodule "registrar.so"
modparam("registrar", "received_avp", "$avp(received)")
modparam("registrar", "tcp_persistent_flag", "TCP_PERSISTENT")
modparam("registrar", "max_contacts", 10)
modparam("registrar", "default_expires", 300)
modparam("registrar", "max_expires", 3600)
loadmodule "nathelper.so"
modparam("nathelper", "received_avp", "$avp(received)")

#### Calls: dialogs followed (transfers in step 3b need them), media through rtpengine
loadmodule "dialog.so"
modparam("dialog", "db_mode", 0)
modparam("dialog", "default_timeout", 14400)
loadmodule "rtpengine.so"
modparam("rtpengine", "rtpengine_sock", "${RTPENGINE_SOCK}")

#### Routing ###########################################################################################################

# Both legs are browsers: DTLS-SRTP (RTP/SAVPF), rtcp-mux, ICE with rtpengine as the only candidate (the browsers
# never see each other's address, and a browser behind a NAT still works), SDP origin and connection rewritten.
# SIP INFO (DTMF) and the other in-dialog requests pass untouched.
route[rtp_offer] {
	if (!rtpengine_offer("ICE=force RTP/SAVPF rtcp-mux-require replace-origin replace-session-connection"))
		xlog("L_ERR", "rtpengine offer failed for $ci\n");
}
route[rtp_answer] {
	if (!rtpengine_answer("ICE=force RTP/SAVPF rtcp-mux-require replace-origin replace-session-connection"))
		xlog("L_ERR", "rtpengine answer failed for $ci\n");
}

route {
	if (!mf_process_maxfwd_header(10)) {
		send_reply(483, "Too Many Hops");
		exit;
	}

	# In-dialog requests (ACK, BYE, re-INVITE for hold, INFO, REFER...) follow the Record-Route.
	if (has_totag()) {
		if (is_method("ACK") && t_check_trans()) {
			if (has_body_part("application/sdp"))
				route(rtp_answer);
			t_relay();
			exit;
		}
		if (!loose_route()) {
			send_reply(404, "Not Here");
			exit;
		}
		# A browser's Contact names a ".invalid" host (RFC 7118): point it at the WebSocket it came from, so the
		# other side's in-dialog requests reach it on that same connection.
		fix_nated_contact();
		if (is_method("INVITE|UPDATE") && has_body_part("application/sdp")) {
			route(rtp_offer);
			t_on_reply("rtp");
		}
		if (is_method("BYE"))
			rtpengine_delete();
		route(relay);
		exit;
	}

	if (is_method("CANCEL")) {
		if (t_check_trans())
			t_relay();
		exit;
	}

	# Absorb retransmissions without creating a transaction.
	t_check_trans();

	if (loose_route()) {
		xlog("L_ERR", "Preloaded Route refused [$fu/$tu/$ru/$ci]\n");
		if (!is_method("ACK"))
			send_reply(403, "Preload Route Denied");
		exit;
	}

	if (is_method("REGISTER")) {
		if (!www_authorize("", "subscriber")) {
			www_challenge("", "auth");
			exit;
		}
		# One may only register one's own address of record.
		if ($au != $tU) {
			send_reply(403, "Forbidden");
			exit;
		}
		# The browser sits behind a NAT and uses a WebSocket: keep where it really came from, and keep the
		# connection open as long as the registration lasts.
		fix_nated_register();
		setbflag("NAT");
		setflag("TCP_PERSISTENT");
		if (!save("location"))
			sl_reply_error();
		exit;
	}

	if (!is_myself("$rd")) {
		send_reply(403, "Relay Forbidden");
		exit;
	}

	if (!is_method("INVITE|OPTIONS|MESSAGE|SUBSCRIBE|PUBLISH")) {
		send_reply(405, "Method Not Allowed");
		exit;
	}
	if (is_method("SUBSCRIBE|PUBLISH|MESSAGE")) {
		send_reply(503, "Service Unavailable");
		exit;
	}
	if (is_method("OPTIONS")) {
		send_reply(200, "OK");
		exit;
	}

	# A call: the caller must be one of our accounts and call as itself.
	if (!proxy_authorize("", "subscriber")) {
		proxy_challenge("", "auth");
		exit;
	}
	if ($au != $fU) {
		send_reply(403, "Forbidden");
		exit;
	}
	consume_credentials();

	if ($rU == NULL) {
		send_reply(484, "Address Incomplete");
		exit;
	}

	record_route();
	fix_nated_contact();
	create_dialog();

	# Every registered window of the callee rings (parallel forking); the first that answers takes the call.
	if (!lookup("location")) {
		t_reply(404, "Not Found");
		exit;
	}

	if (has_body_part("application/sdp"))
		route(rtp_offer);
	t_on_reply("rtp");
	t_on_failure("call_failed");
	route(relay);
}

route[relay] {
	if (!t_relay())
		send_reply(500, "Internal Error");
}

onreply_route[rtp] {
	# The callee's Contact: same ".invalid" host, same fix (see above).
	fix_nated_contact();
	if (has_body_part("application/sdp"))
		route(rtp_answer);
}

failure_route[call_failed] {
	if (t_was_cancelled())
		exit;
	rtpengine_delete();
	# A registered window that is gone (tab closed without unregistering): "unreachable" for the caller, not a
	# transport error.
	if (t_check_status("477"))
		t_reply(480, "Temporarily Unavailable");
}
