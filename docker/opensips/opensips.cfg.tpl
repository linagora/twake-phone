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
#### `call_rules` (same database as `subscriber`), read at each call. Raw queries, on a user part checked first,
#### through their own connections: OPENSIPS_RULES_DB_URL is OPENSIPS_DB_URL with a short statement_timeout
#### (entrypoint.sh), so that a slow database delays a call by that much at most, and never holds a process longer.
loadmodule "sqlops.so"
modparam("sqlops", "db_url", "${OPENSIPS_RULES_DB_URL}")

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
	# A session rtpengine holds for this call: a refusal after it (failure_route) frees it.
	$avp(rtp_on) = 1;
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

	# The INVITE that completes an attended transfer (Replaces) goes where the call it replaces went: the extension
	# named in it may have forwarded that call elsewhere (the transferor dialled 104, 104's rules took it to 103).
	$var(replaces_to) = "";
	if (is_present_hf("Replaces"))
		route(replaces_target);

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
	# acc's `callee` is the extension the call reached (route[forward_to] moves it): the one that rang, answered or
	# refused, as the Gateway counts it; what the caller dialled is in the events (`dialled`).
	$acc_extra(callee) = $rU;
	# The missed call is accounted once nothing can forward the call any more (route[arm_failure]): acc reports the
	# first failure only, and a forward on busy or no answer comes after that failure.
	do_accounting("db|evi", "cdr");
	$avp(fwd_hops) = 0;
	$avp(fwd_seen) = "," + $rU + ",";

	if (is_present_hf("Replaces")) {
		# No rules for it: it must reach the very call it replaces.
		if ($var(replaces_to) != "") {
			$ru = "sip:" + $var(replaces_to) + "@" + $avp(domain);
			$(avp(callee)[*]) = NULL;
			$avp(callee) = $var(replaces_to);
			$acc_extra(callee) = $var(replaces_to);
		}
		if (!lookup("location")) {
			route(account_missed);
			route(calling);
			t_reply(404, "Not Found");
			exit;
		}
		route(ring);
		exit;
	}

	# The callee's rules (immediate forward, "do not disturb"), followed from extension to extension, then every
	# registered window of the extension reached rings: route[rules_next] reads them without holding this process.
	route(rules_next);
	exit;
}

# The call rings the windows found by the lookup ($ru and the branches): media offer, then the relay. The extension it
# rings is kept in the dialog: an INVITE with Replaces for this call is sent there (route[replaces_target]).
route[ring] {
	$dlg_val(callee) = $avp(callee);
	if (has_body_part("application/sdp"))
		route(rtp_offer);
	t_on_reply("rtp");
	t_on_failure("call_failed");
	route(arm_failure);
	# The call starts: told to the Gateway only now, once nothing can refuse it without a transaction: from here on,
	# acc tells how it ended, save the rare 500 of a relay that fails before any transaction (route[relay]), caught
	# up like a lost event (ADR 0011).
	route(calling);
	route(relay);
}

# The extension the call named in Replaces reached, from the dialog of that call ($var(replaces_to); empty when this
# proxy does not know the call: the INVITE then goes to the extension it names, as dialled).
route[replaces_target] {
	$var(replaced) = $(hdr(Replaces){s.select,0,;});
	if ($var(replaced) == NULL || $var(replaced) == "")
		return(-1);
	if (!load_dialog_ctx($var(replaced), "callid"))
		return(-1);
	$var(reached) = $dlg_val(callee);
	unload_dialog_ctx();
	if ($var(reached) != NULL && $var(reached) =~ "^[A-Za-z0-9._+-]{1,64}$" && $var(reached) != $fU)
		$var(replaces_to) = $var(reached);
	return(1);
}

# Ringing, answer and end follow: our own events, then acc's CDR or missed call.
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
#
# The rules of the extension now called ($rU) come from `call_rules`, one query on its primary key: asynchronous in
# the request route (route[rules_next]: the process serves other messages while PostgreSQL answers), synchronous in
# failure_route (async is not available there). Both are bounded by the statement_timeout of OPENSIPS_RULES_DB_URL
# (entrypoint.sh). None when the extension has no row, when the query fails or times out (the call goes on,
# unforwarded) or for a user part that cannot be one of ours. The "do not disturb" holds while its end is ahead on
# the database's clock: it lifts at its date by itself.

# The query for $rU: only the characters a `subscriber` user name has get there, nothing that could close its quote.
route[rules_query] {
	$(avp(r_always)[*]) = NULL;
	$(avp(r_busy)[*]) = NULL;
	$(avp(r_noanswer)[*]) = NULL;
	$(avp(r_delay)[*]) = NULL;
	$(avp(r_dnd)[*]) = NULL;
	$(avp(r_message)[*]) = NULL;
	$(avp(r_retry)[*]) = NULL;
	if (!($rU =~ "^[A-Za-z0-9._+-]{1,64}$"))
		return(-1);
	$var(rules_query) = "SELECT forward_always, forward_busy, forward_noanswer, noanswer_delay, CASE WHEN dnd AND (dnd_until IS NULL OR dnd_until > now()) THEN 1 ELSE 0 END, regexp_replace(dnd_message, '[[:cntrl:]]', '', 'g'), CASE WHEN dnd AND dnd_until > now() THEN ceil(extract(epoch FROM dnd_until - now()))::integer END FROM call_rules WHERE extension = '" + $rU + "'";
	return(1);
}

# Request route: reads the rules of $rU without blocking, then route[rules_step] (from route[rules_loaded], where it resumes).
route[rules_next] {
	if (!route(rules_query)) {
		route(rules_step);
		exit;
	}
	async(sql_query_one("$var(rules_query)", "$avp(r_always);$avp(r_busy);$avp(r_noanswer);$avp(r_delay);$avp(r_dnd);$avp(r_message);$avp(r_retry)"), rules_loaded);
}

route[rules_loaded] {
	# 1: a row; -2: none; any other failure (timeout, database down): no rules, the call goes on.
	if ($rc < 0 && $rc != -2)
		xlog("L_WARN", "call $ci: rules of $rU not read ($rc), the call goes on without them\n");
	route(rules_step);
}

# What the rules just read say, in the request route: another extension (its rules are read in turn), the windows
# to ring, a refusal (route[dnd_refuse], which ends the script) or nobody to ring.
route[rules_step] {
	# The dialled extension's own "do not disturb": its refusal is the one the caller hears if the chain it forwards
	# to ends nowhere (route[unreachable]).
	if ($avp(fwd_hops) == 0 && $avp(d_loaded) == NULL) {
		$avp(d_loaded) = 1;
		if ($avp(r_dnd) == 1) {
			$avp(d_dnd) = 1;
			if ($avp(r_message) != NULL)
				$avp(d_message) = $avp(r_message);
			if ($avp(r_retry) != NULL)
				$avp(d_retry) = $avp(r_retry);
		}
	}
	route(rules_decide);
	$var(decided) = $rc;
	if ($var(decided) == 1) {
		route(rules_next);
		exit;
	}
	if ($var(decided) == 2) {
		route(ring);
		exit;
	}
	route(unreachable);
	exit;
}

# The rules of the extension reached, loaded in $avp(r_*): 1 the call moved to another extension (load its rules
# next), 2 its windows are found (ring them), -1 nobody to ring. A refusal ends the script (route[dnd_refuse]).
# Before ringing: the immediate forward; during a "do not disturb", the no-answer forward, else the busy one, else a
# refusal. Nobody registered: the no-answer forward, at once (nobody can answer).
route[rules_decide] {
	$var(next) = "";
	if ($avp(r_always) != NULL)
		$var(next) = $avp(r_always);
	else if ($avp(r_dnd) == 1 && $avp(r_noanswer) != NULL)
		$var(next) = $avp(r_noanswer);
	else if ($avp(r_dnd) == 1 && $avp(r_busy) != NULL)
		$var(next) = $avp(r_busy);
	if ($var(next) != "" && route(forward_to, $var(next)))
		return(1);
	if ($avp(r_dnd) == 1)
		route(dnd_refuse);
	if (lookup("location"))
		return(2);
	if ($avp(r_noanswer) != NULL && route(forward_to, $avp(r_noanswer)))
		return(1);
	return(-1);
}

# failure_route: the same, synchronously, until there are windows to ring (2) or nobody (-1).
route[rules_sync] {
	$var(sync_hops) = 0;
	while ($var(sync_hops) < 4) {
		$var(sync_hops) = $var(sync_hops) + 1;
		if (route(rules_query)) {
			sql_query_one("$var(rules_query)", "$avp(r_always);$avp(r_busy);$avp(r_noanswer);$avp(r_delay);$avp(r_dnd);$avp(r_message);$avp(r_retry)");
			# -2: no row; any other failure (timeout, database down): no rules, the call goes on.
			if ($rc < 0 && $rc != -2)
				xlog("L_WARN", "call $ci: rules of $rU not read ($rc), the call goes on without them\n");
		}
		route(rules_decide);
		$var(decided) = $rc;
		if ($var(decided) != 1)
			return($var(decided));
	}
	return(-1);
}

# Nobody to ring at the end of the request route. The dialled extension does not want to be disturbed (its
# forward led nowhere): its refusal, with its message. Else 404 for an extension nobody registered, and 480 for a
# call forwarded to one (the extension dialled exists: it cannot be reached now).
route[unreachable] {
	if ($avp(d_dnd) == 1)
		route(dnd_refuse_dialled);
	route(account_missed);
	route(calling);
	if ($avp(fwd_hops) == 0)
		t_reply(404, "Not Found");
	else
		t_reply(480, "Temporarily Unavailable");
	exit;
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
	$acc_extra(callee) = $param(1);
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

# $avp(callee) does not want to be disturbed and has nowhere to forward to. Its message is for those who called it:
# when the call came to it by a forward, the caller dialled someone else, who is answered for instead.
route[dnd_refuse] {
	if ($avp(callee) == $avp(dialled)) {
		$var(dnd_who) = $avp(callee);
		$var(dnd_told) = 1;
		$var(dnd_message) = "";
		if ($avp(r_message) != NULL)
			$var(dnd_message) = $avp(r_message);
		$var(dnd_retry) = 0;
		if ($avp(r_retry) != NULL)
			$var(dnd_retry) = $avp(r_retry);
		route(dnd_reply);
	}
	if ($avp(d_dnd) == 1)
		route(dnd_refuse_dialled);
	# The dialled extension forwarded the call to a colleague who does not want to be disturbed: their refusal, a
	# missed call for them, but neither their message nor their "do not disturb" for a caller who did not call them.
	$var(dnd_who) = $avp(callee);
	$var(dnd_told) = 0;
	route(dnd_reply);
}

# The dialled extension's own "do not disturb" (read before its forward led nowhere), with its message.
route[dnd_refuse_dialled] {
	$var(dnd_who) = $avp(dialled);
	$var(dnd_told) = 1;
	$var(dnd_message) = "";
	if ($avp(d_message) != NULL)
		$var(dnd_message) = $avp(d_message);
	$var(dnd_retry) = 0;
	if ($avp(d_retry) != NULL)
		$var(dnd_retry) = $avp(d_retry);
	route(dnd_reply);
}

# The refusal for $var(dnd_who). Told as a "do not disturb" ($var(dnd_told)): 480 Do Not Disturb (RFC 3261: the
# callee asked not to be disturbed), `Twake-Dnd: 1` (what the softphone keys on: a reason phrase may be rewritten on
# the way), the message (Twake-Dnd-Message) and when to try again. Not told: a plain 480. Either way a missed call
# for $var(dnd_who) (E_TWAKEPHONE_DND says whose: acc's missed call has the standard reason phrase).
route[dnd_reply] {
	$(avp(callee)[*]) = NULL;
	$avp(callee) = $var(dnd_who);
	$acc_extra(callee) = $var(dnd_who);
	if ($var(dnd_told) == 1) {
		append_to_reply("Twake-Dnd: 1\r\n");
		if ($var(dnd_message) != "")
			append_to_reply("Twake-Dnd-Message: $var(dnd_message)\r\n");
		if ($var(dnd_retry) > 0)
			append_to_reply("Retry-After: $var(dnd_retry)\r\n");
	}
	# The offer rtpengine answered (a refusal in failure_route, after a forward) is over.
	if ($avp(rtp_on) != NULL)
		rtpengine_delete();
	route(account_missed);
	route(calling);
	route(event_attrs);
	$avp(ev_attr) = "told";
	if ($var(dnd_told) == 1)
		$avp(ev_val) = "1";
	else
		$avp(ev_val) = "0";
	raise_event("E_TWAKEPHONE_DND", $avp(ev_attr), $avp(ev_val));
	if ($var(dnd_told) == 1)
		t_reply(480, "Do Not Disturb");
	else
		t_reply(480, "Temporarily Unavailable");
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
	# A registered contact that cannot be reached (window gone without unregistering): 477 "Send failed", that the
	# softphone renders as "unreachable" (proven by the e2e). tm answers it itself when it creates the transaction
	# here; once the rules were read (async created it), it is answered from the script. The 500 is for a relay that
	# fails otherwise before any reply.
	if (!t_relay()) {
		if ($rc == -6)
			t_reply(477, "Send failed");
		else
			send_reply(500, "Internal Error");
	}
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
			# When the windows of this callee started ringing: failure_route tells a ringing that lasted its delay.
			$(avp(ring_at)[*]) = NULL;
			$avp(ring_at) = $Ts;
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
	# no-answer one when the ringing lasted its delay (408, our timer) or their window could not be reached. With
	# several windows, one in a call answers 486 at once while another rings: once the delay is over tm prefers that
	# 486 to its own 408, yet nobody answered the free window: a no answer (a 486 after the delay of ringing).
	$var(rang_out) = 0;
	if ($avp(r_noanswer) != NULL && $avp(ring_at) != NULL) {
		$var(rang_for) = $Ts - $avp(ring_at);
		$var(rang_min) = $avp(r_delay) - 1;
		if ($var(rang_for) >= $var(rang_min))
			$var(rang_out) = 1;
	}
	$var(next) = "";
	if ((t_check_status("600|603") || (t_check_status("486") && $var(rang_out) == 0)) && $avp(r_busy) != NULL)
		$var(next) = $avp(r_busy);
	else if ((t_check_status("408|477|480|503") || $var(rang_out) == 1) && $avp(r_noanswer) != NULL)
		$var(next) = $avp(r_noanswer);
	$var(from) = $avp(callee);
	$var(code) = $T_reply_code;
	if ($var(next) != "" && route(forward_to, $var(next))) {
		$(avp(ringing)[*]) = NULL;
		$(avp(ring_at)[*]) = NULL;
		route(rules_sync);
		if ($rc == 2) {
			# The same offer (rtpengine's, from the request route) goes to the new callee: its answer completes it.
			$dlg_val(callee) = $avp(callee);
			route(forwarded, $var(from), $var(code));
			t_on_reply("rtp");
			t_on_failure("call_failed");
			route(arm_failure);
			route(relay);
			exit;
		}
		# Nobody to ring where the forward led: the dialled extension's "do not disturb" if it has one, else the
		# failure of the extension that rang (the reply tm picked), for it.
		if ($avp(d_dnd) == 1)
			route(dnd_refuse_dialled);
		$(avp(callee)[*]) = NULL;
		$avp(callee) = $var(from);
		$acc_extra(callee) = $var(from);
	}
	# Over: the caller gets the best failure, the media session is freed, the missed call accounted.
	rtpengine_delete();
	route(account_missed);
}
