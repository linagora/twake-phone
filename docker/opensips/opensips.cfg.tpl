####### TwakePhone: OpenSIPS 3.6 for the web MVP (step 3) ##############################################################
# Rendered by entrypoint.sh from the environment (${VAR}). Registrar of the browsers (SIP over WS and WSS), digest
# authentication on the `subscriber` table the Gateway fills, calls between registered users through rtpengine
# (DTLS-SRTP on both legs), hold by re-INVITE, transfers by REFER and Replaces between the browsers (ADR 0010: the
# proxy relays them, it does not implement them). Step 4: what happens here is told to the Gateway through the
# Event Interface (registrations, ringing, answered, CDR, missed calls; `event_datagram` to the address the
# Gateway gives when it subscribes through MI, the loopback by default) and accounted in the database (`acc`,
# `missed_calls`). Step 4b (ADR 0013): each call follows the rules its callee set in the app, read from `call_rules`
# at each INVITE (immediate forward, forward on busy and on no answer, "do not disturb" until a date with a message
# for the caller). Trunk and groups come with steps 4c and 6. Everything in here is OpenSIPS-specific; the Gateway
# only knows `provider-opensips`.

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
# MI for the Gateway (provider-opensips): JSON-RPC over UDP (event subscriptions, uptime, ul_dump, dlg_list), on its
# own address, the loopback by default: it has no authentication, and opening SIP to a network (LISTEN_IP) must not
# open it too. entrypoint.sh refuses a MI_LISTEN_IP that is neither loopback nor private unless told otherwise.
loadmodule "mi_datagram.so"
modparam("mi_datagram", "socket_name", "udp:${MI_LISTEN_IP}:${MI_PORT}")

#### Events towards the Gateway: JSON-RPC notifications over UDP to whoever subscribed through MI (event_subscribe)
loadmodule "event_datagram.so"

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

#### Calls: dialogs followed (only ours pass in-dialog; REFER and NOTIFY of the transfers ride them), media through rtpengine
loadmodule "dialog.so"
modparam("dialog", "db_mode", 0)
modparam("dialog", "default_timeout", 14400)
loadmodule "rtpengine.so"
modparam("rtpengine", "rtpengine_sock", "${RTPENGINE_SOCK}")

#### Call rules (step 4b, ADR 0013): forwards and "do not disturb" per extension, written by the Gateway in
#### `call_rules` (same database as `subscriber`), read at each call. Raw queries, on a user part checked first.
loadmodule "sqlops.so"
modparam("sqlops", "db_url", "${OPENSIPS_DB_URL}")

#### Accounting: CDRs in the database (the reference history) and the same as events for the Gateway (E_ACC_EVENT at
#### the answer, E_ACC_CDR at the end of the dialog, E_ACC_MISSED_EVENT for a call that did not go through). Caller
#### and callee as extra fields: the default ones only carry tags and the Call-ID.
loadmodule "acc.so"
modparam("acc", "db_url", "${OPENSIPS_DB_URL}")
modparam("acc", "extra_fields", "db: caller; callee")
modparam("acc", "extra_fields", "evi: caller; callee")

#### Routing ###########################################################################################################

# Both legs are browsers: DTLS-SRTP (RTP/SAVPF), rtcp-mux, ICE with rtpengine as the only candidate (the browsers
# never see each other's address, and a browser behind a NAT still works), SDP origin and connection rewritten.
# SIP INFO (DTMF) and the other in-dialog requests pass untouched.
route[rtp_offer] {
	if (!rtpengine_offer("ICE=force RTP/SAVPF rtcp-mux-require replace-origin replace-session-connection")) {
		# Never relay the browser's own SDP: without rtpengine the call would go browser to browser.
		xlog("L_ERR", "rtpengine offer failed for $ci\n");
		send_reply(503, "Media Unavailable");
		exit;
	}
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
		# Only a dialog this proxy created (an authenticated INVITE between two of its accounts) goes further:
		# a forged To-tag plus a Route naming us would otherwise turn loose_route() into an open relay.
		if (!match_dialog()) {
			if (!is_method("ACK"))
				send_reply(481, "Call/Transaction Does Not Exist");
			exit;
		}
		if (!is_method("INVITE|UPDATE|ACK|BYE|INFO|REFER|NOTIFY|PRACK|OPTIONS")) {
			send_reply(405, "Method Not Allowed");
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

	# Who calls whom, as dialled (the Request-URI changes with the lookup): for the CDR and the events. `callee` is
	# where the call goes now (the callee's rules may move it), `dialled` stays what the caller dialled.
	$avp(caller) = $fU;
	$avp(callee) = $rU;
	$avp(dialled) = $rU;
	$avp(domain) = $rd;
	$acc_extra(caller) = $fU;
	$acc_extra(callee) = $rU;
	# The missed call is accounted once nothing can forward the call any more (route[arm_failure]): acc reports the
	# first failure only, and a forward on busy or no answer comes after that failure.
	do_accounting("db|evi", "cdr");

	# The callee's rules (immediate forward, "do not disturb"), followed from extension to extension. Not for the
	# INVITE that completes an attended transfer (Replaces): it must reach the very call it replaces.
	$avp(fwd_hops) = 0;
	$avp(fwd_seen) = "," + $rU + ",";
	if (!is_present_hf("Replaces"))
		route(rules_before);

	# Every registered window of the callee rings (parallel forking); the first that answers takes the call.
	if (!route(reach)) {
		# Refused through a transaction: acc tells the Gateway (missed event, 404) how the call it announces ended.
		route(account_missed);
		route(calling);
		t_reply(404, "Not Found");
		exit;
	}

	if (has_body_part("application/sdp"))
		route(rtp_offer);
	t_on_reply("rtp");
	t_on_failure("call_failed");
	route(arm_failure);
	# The call starts: told to the Gateway only now, once nothing can refuse it without a transaction (rtp_offer
	# answers 503 statelessly, which acc never sees): from here on, acc tells how it ended, save the rare 500 of a
	# relay that fails before any transaction (route[relay]), caught up like a lost event (ADR 0011).
	route(calling);
	route(relay);
}

# Ringing, answer and end follow: our own events, then acc's CDR or missed call. No t_newtran() here: with a
# transaction created before t_relay, tm no longer answers 477 itself to a contact it cannot send to (the e2e saw
# the 500 below instead), and the softphone would say "error" for "unreachable".
route[calling] {
	if ($avp(calling_told) != NULL)
		return(1);
	$avp(calling_told) = 1;
	route(event_attrs);
	raise_event("E_TWAKEPHONE_CALLING", $avp(ev_attr), $avp(ev_val));
}

#### Call rules (step 4b, ADR 0013) ####################################################################################
# A forward follows the rules of the extension it reaches (its own immediate forward, its "do not disturb") up to
# three forwards per call, never back to the caller nor to an extension the call already went through: past that,
# the extension reached rings (or refuses, if it does not want to be disturbed). The Gateway refuses a forward to
# oneself and checks every target is one of our extensions.

# The rules of the extension now called ($rU) into $avp(r_*), from `call_rules`: none (-1) when it has no row, when
# the database does not answer (the call goes on, unforwarded) or for a user part that cannot be one of ours. The
# "do not disturb" holds while its end is ahead on the database's clock: it lifts at its date by itself.
route[load_rules] {
	$(avp(r_always)[*]) = NULL;
	$(avp(r_busy)[*]) = NULL;
	$(avp(r_noanswer)[*]) = NULL;
	$(avp(r_delay)[*]) = NULL;
	$(avp(r_dnd)[*]) = NULL;
	$(avp(r_message)[*]) = NULL;
	$(avp(r_retry)[*]) = NULL;
	# The only characters a `subscriber` user name has: nothing that could close the quote of the query below.
	if (!($rU =~ "^[A-Za-z0-9._+-]{1,64}$"))
		return(-1);
	if (!sql_query_one("SELECT forward_always, forward_busy, forward_noanswer, noanswer_delay, CASE WHEN dnd AND (dnd_until IS NULL OR dnd_until > now()) THEN 1 ELSE 0 END, regexp_replace(dnd_message, '[[:cntrl:]]', '', 'g'), CASE WHEN dnd AND dnd_until > now() THEN ceil(extract(epoch FROM dnd_until - now()))::integer END FROM call_rules WHERE extension = '$rU'",
			"$avp(r_always);$avp(r_busy);$avp(r_noanswer);$avp(r_delay);$avp(r_dnd);$avp(r_message);$avp(r_retry)"))
		return(-1);
	return(1);
}

# Before anything rings: the immediate forward; during a "do not disturb", the no-answer forward, else the busy
# one, else a refusal with the callee's message. Then the rules of the extension the call moved to, and so on.
route[rules_before] {
	while (route(load_rules)) {
		$var(next) = "";
		if ($avp(r_always) != NULL)
			$var(next) = $avp(r_always);
		else if ($avp(r_dnd) == 1 && $avp(r_noanswer) != NULL)
			$var(next) = $avp(r_noanswer);
		else if ($avp(r_dnd) == 1 && $avp(r_busy) != NULL)
			$var(next) = $avp(r_busy);
		if ($var(next) == "" || !route(forward_to, $var(next))) {
			# Nowhere (else) to go: a callee who does not want to be disturbed refuses, anyone else rings.
			if ($avp(r_dnd) == 1)
				route(dnd_refuse);
			break;
		}
	}
}

# Finds the registered windows of $rU; with none, its no-answer forward (at once: nobody can answer) and the rules of
# the extension it leads to. -1: nothing to ring.
route[reach] {
	while (!lookup("location")) {
		if ($avp(r_noanswer) == NULL || !route(forward_to, $avp(r_noanswer)))
			return(-1);
		route(rules_before);
	}
	return(1);
}

# Moves the call to extension $param(1), unless that would loop (back to the caller, to an extension the call went
# through, past three forwards): -1 then, and the call stays where it is.
route[forward_to] {
	if ($avp(fwd_hops) >= 3) {
		xlog("L_NOTICE", "call $ci: not forwarded to $param(1), three forwards already\n");
		return(-1);
	}
	$var(seen) = "," + $param(1) + ",";
	if ($param(1) == $avp(caller) || $(avp(fwd_seen){s.index,$var(seen)}) != NULL) {
		xlog("L_NOTICE", "call $ci: not forwarded to $param(1), it would loop\n");
		return(-1);
	}
	$var(hops) = $avp(fwd_hops) + 1;
	$(avp(fwd_hops)[*]) = NULL;
	$avp(fwd_hops) = $var(hops);
	$var(seen) = $avp(fwd_seen) + $param(1) + ",";
	$(avp(fwd_seen)[*]) = NULL;
	$avp(fwd_seen) = $var(seen);
	# The whole Request-URI: after a lookup (failure route) it names a window of the previous callee.
	$ru = "sip:" + $param(1) + "@" + $avp(domain);
	$du = NULL;
	$(avp(callee)[*]) = NULL;
	$avp(callee) = $param(1);
	return(1);
}

# Before ringing: when a forward can still follow a failure, the ringing lasts the no-answer delay (if that forward
# is set) and the missed call waits for failure_route; otherwise the missed call is accounted now.
route[arm_failure] {
	if ($avp(fwd_hops) < 3 && ($avp(r_busy) != NULL || $avp(r_noanswer) != NULL)) {
		if ($avp(r_noanswer) != NULL)
			$T_fr_inv_timeout = $avp(r_delay);
		else
			$T_fr_inv_timeout = NULL;
	} else {
		$T_fr_inv_timeout = NULL;
		route(account_missed);
	}
}

# Once per call: acc then reports the call that did not go through (E_ACC_MISSED_EVENT, `missed_calls`).
route[account_missed] {
	if ($avp(missed_on) != NULL)
		return(1);
	$avp(missed_on) = 1;
	do_accounting("db|evi", "missed");
}

# A "do not disturb" with nowhere to forward to: refused with 480 (RFC 3261: the callee asked not to be
# disturbed), the callee's message for the caller (Twake-Dnd-Message, read by the softphone) and when to try again.
# A missed call for the callee (E_TWAKEPHONE_DND says whose: acc's missed call has the standard reason phrase).
route[dnd_refuse] {
	if ($avp(r_message) != NULL && $avp(r_message) != "")
		append_to_reply("Twake-Dnd-Message: $avp(r_message)\r\n");
	if ($avp(r_retry) != NULL)
		append_to_reply("Retry-After: $avp(r_retry)\r\n");
	route(account_missed);
	route(calling);
	route(event_attrs);
	raise_event("E_TWAKEPHONE_DND", $avp(ev_attr), $avp(ev_val));
	t_reply(480, "Do Not Disturb");
	exit;
}

# The call left $param(1) (busy, declined or no answer, status $param(2)) for $avp(callee): told to the Gateway.
route[forwarded] {
	route(event_attrs);
	$avp(ev_attr) = "from";
	$avp(ev_val) = $param(1);
	$avp(ev_attr) = "code";
	$avp(ev_val) = $param(2);
	raise_event("E_TWAKEPHONE_FORWARDED", $avp(ev_attr), $avp(ev_val));
}

route[relay] {
	# A registered contact that cannot be reached (window gone without unregistering) makes tm answer
	# 477 "Send failed" itself: the softphone renders it as "unreachable" (proven by the e2e). The 500 below is
	# for a relay that fails before any reply.
	if (!t_relay())
		send_reply(500, "Internal Error");
}

onreply_route[rtp] {
	# The callee's Contact: same ".invalid" host, same fix (see above).
	fix_nated_contact();
	if (has_body_part("application/sdp"))
		route(rtp_answer);
	# Ringing and answer are not accounted: told to the Gateway as events of our own, once per call. Only the
	# initial INVITE carries $avp(callee): the 200 of a re-INVITE (hold, resume) raises nothing.
	if ($avp(callee) != NULL) {
		if (($rs == 180 || $rs == 183) && $avp(ringing) == NULL) {
			$avp(ringing) = 1;
			route(event_attrs);
			raise_event("E_TWAKEPHONE_RINGING", $avp(ev_attr), $avp(ev_val));
		} else if ($rs == 200 && $avp(answered) == NULL) {
			$avp(answered) = 1;
			route(event_attrs);
			raise_event("E_TWAKEPHONE_ANSWERED", $avp(ev_attr), $avp(ev_val));
		}
	}
}

# The attributes of our events (E_TWAKEPHONE_*): who calls whom as dialled, and the Call-ID the CDR carries too.
route[event_attrs] {
	# Every value: `$avp(x) = NULL` only removes the last one, and these lists are built anew for each event.
	$(avp(ev_attr)[*]) = NULL;
	$(avp(ev_val)[*]) = NULL;
	$avp(ev_attr) = "callee";
	$avp(ev_val) = $avp(callee);
	$avp(ev_attr) = "dialled";
	$avp(ev_val) = $avp(dialled);
	$avp(ev_attr) = "caller";
	$avp(ev_val) = $avp(caller);
	$avp(ev_attr) = "callid";
	$avp(ev_val) = $ci;
}

failure_route[call_failed] {
	# Cancelled: the media session is over, free rtpengine's ports; the missed call is the callee's.
	if (t_was_cancelled()) {
		rtpengine_delete();
		route(account_missed);
		exit;
	}
	# The callee's busy forward when a window of theirs is already in a call (486) or they declined (603, 600); the
	# no-answer one when the ringing lasted its delay (408, our timer) or their window could not be reached.
	$var(next) = "";
	if (t_check_status("486|600|603") && $avp(r_busy) != NULL)
		$var(next) = $avp(r_busy);
	else if (t_check_status("408|477|480|503") && $avp(r_noanswer) != NULL)
		$var(next) = $avp(r_noanswer);
	$var(from) = $avp(callee);
	$var(code) = $T_reply_code;
	if ($var(next) != "" && route(forward_to, $var(next))) {
		$(avp(ringing)[*]) = NULL;
		route(rules_before);
		if (route(reach)) {
			# The same offer (rtpengine's, from the request route) goes to the new callee: its answer completes it.
			route(forwarded, $var(from), $var(code));
			t_on_reply("rtp");
			t_on_failure("call_failed");
			route(arm_failure);
			route(relay);
			exit;
		}
	}
	# Over: the caller gets the best failure, the media session is freed, the missed call accounted.
	rtpengine_delete();
	route(account_missed);
}
