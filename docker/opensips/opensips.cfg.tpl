####### TwakePhone: OpenSIPS 3.6 for the web MVP (step 3) ##############################################################
# Rendered by entrypoint.sh from the environment (${VAR}). Registrar of the browsers (SIP over WS and WSS), digest
# authentication on the `subscriber` table the Gateway fills, calls between registered users through rtpengine
# (DTLS-SRTP on both legs), hold by re-INVITE, transfers by REFER and Replaces between the browsers (ADR 0010: the
# proxy relays them, it does not implement them). Step 4: what happens here is told to the Gateway through the
# Event Interface (registrations, ringing, answered, CDR, missed calls; `event_datagram` to the address the
# Gateway gives when it subscribes through MI, the loopback by default) and accounted in the database (`acc`,
# `missed_calls`). Step 4b (ADR 0013): each call follows the rules its callee set in the app, read from `call_rules`
# at each INVITE (immediate forward, forward on busy and on no answer, "do not disturb" until a date with a message
# for the caller). Step 4c (ADR 0014): simultaneous ring groups (`call_groups`: a number of its own rings the
# registered windows of its members at once, 12 at most, the first to answer takes the call) and the directory names
# (`display_names`): the callee's phone shows the caller's name in the From, the caller's the name of who answered
# (P-Asserted-Identity in the 2xx), whatever the phones claim. Step 6 (ADR 0016): calls to and from the public
# network through the operator's trunk, on a UDP socket of its own (route[trunk_in], route[trunk_out]), with the
# numbering plan of `dialplan`, the operator's servers in `dispatcher` and the registrations of `uac_registrant`, all
# written by the Gateway; the emergency numbers go out whatever the policy. Everything in here is OpenSIPS-specific;
# the Gateway only knows `provider-opensips`.

log_level=${OPENSIPS_LOG_LEVEL}
xlog_level=${OPENSIPS_LOG_LEVEL}
stderror_enabled=yes
syslog_enabled=no
# What OpenSIPS answers or sends itself names the product, never its version (the operator sees it).
server_header="Server: TwakePhone"
user_agent_header="User-Agent: TwakePhone"

udp_workers=2
tcp_workers=4
# A browser's WebSocket stays open as long as its registration (tcp_persistent_flag below).
tcp_connection_lifetime=3605
# Each SIP process opens a database connection per asynchronous read in flight (the call rules, below) and keeps it
# for the next ones: at most 3 per process (6 processes, 18 connections to the database the Gateway uses too). Past
# that, a read runs synchronously in the process, bounded by RULES_QUERY_TIMEOUT_MS like the others.
db_max_async_connections=3

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
# The trunk's own socket (step 6, ADR 0016; ARCHITECTURE §13): never 5060 by default (some NATs drop what leaves from
# it), and no other address declared unless TRUNK_ADVERTISE says so: the operator answers where the packets come from.
socket=udp:${TRUNK_LISTEN_IP}:${TRUNK_PORT}${TRUNK_SOCKET_AS}

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
# A 6xx (a window declining) ends only its own branch: a member of a ring group declining must not cancel the
# colleagues' phones. For any other call, onreply_route[rtp] cancels the other branches that answered something
# (tm sends no CANCEL to a branch that has said nothing yet, RFC 3261): one that never answers (a frozen tab) holds
# the 6xx back until its fr_timeout (5 s).
modparam("tm", "disable_6xx_block", 1)
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
# A call with the operator (ADR 0016) lives as long as its phone does: OpenSIPS sends that side an OPTIONS in the
# dialog every CALL_PING_SEC (create_dialog flags P and p), and a phone that does not answer it (408: put to sleep,
# its page closed or reloaded, its network gone) or no longer knows the call (481) has the call ended, a BYE to both
# sides: the operator's leg is never left open and charged. Any other answer (200, 405, 501...) says the phone is
# there. Nothing else ends a call: not the app's own connection to the Gateway, an emergency call least of all. Past
# TRUNK_MAX_CALL_SEC, a call with the operator ends too (create_dialog("B")), an emergency call excepted.
modparam("dialog", "options_ping_interval", ${CALL_PING_SEC})
loadmodule "rtpengine.so"
modparam("rtpengine", "rtpengine_sock", "${RTPENGINE_SOCK}")

#### Directory names (step 4c, ADR 0014): the display name of the From is replaced by the caller's, as `display_names`
#### holds it (route[caller_name]). Only the display changes, never the URI or the tags: nothing to restore on the
#### way back, and the digest the caller computed (on the Request-URI) is checked before.
loadmodule "uac.so"
modparam("uac", "restore_mode", "none")

#### Call rules (step 4b, ADR 0013): forwards and "do not disturb" per extension, written by the Gateway in
#### `call_rules` (same database as `subscriber`), read at each call, asynchronously (the process serves other
#### messages meanwhile), with the ring groups and directory names of step 4c (`call_groups`, `display_names`). Raw queries, on a user part checked first, through their own connections:
#### OPENSIPS_RULES_DB_URL is OPENSIPS_DB_URL with a short statement_timeout (entrypoint.sh), so that a slow database
#### delays a call by that much per read at most. Nothing is read in failure_route (see route[ring]).
loadmodule "sqlops.so"
modparam("sqlops", "db_url", "${OPENSIPS_RULES_DB_URL}")
# A read that fails is made again once (route[read_failed]): the database may have dropped the connection (a restart,
# a failover, an idle timeout), which the next query makes again. The tables of step 4c (`call_groups`,
# `display_names`) may be missing (a database the Gateway has not upgraded yet): the rules must not depend on them.
# When a read naming them fails, the database is asked whether they exist (to_regclass); only when it says they do
# not are they left out, for every process, 30 s ($shv(no4c_until)), and the read is made again without them.
loadmodule "cfgutils.so"
modparam("cfgutils", "shvset", "no4c_until=i:0")
# The table of step 5 (`push_targets`) likewise: when the database says it is missing, nobody is woken for 30 s.
modparam("cfgutils", "shvset", "no5_until=i:0")

#### Calls to someone without a window (step 5, ADR 0015): when the extension a call reaches has no registered window
#### and its holder has a browser to wake (`push_targets`, written by the Gateway for a person with a push
#### subscription), the transaction waits for a window to register (t_wait_for_new_branches) while the Gateway sends
#### the push (E_TWAKEPHONE_WAKE); the first window that registers (E_UL_CONTACT_INSERT, notify_on_event of the
#### event_routing module) is rung in that very transaction (t_inject_branches). Nobody within the delay: the
#### no-answer forward, or the failure as before (route[hold]).
loadmodule "event_routing.so"

#### Accounting: CDRs in the database (the reference history) and the same as events for the Gateway (E_ACC_EVENT at
#### the answer, E_ACC_CDR at the end of the dialog, E_ACC_MISSED_EVENT for a call that did not go through). Caller,
#### callee (the extension the call reached) and dialled (what the caller dialled) as extra fields: the default ones
#### only carry tags and the Call-ID.
loadmodule "acc.so"
modparam("acc", "db_url", "${OPENSIPS_DB_URL}")
modparam("acc", "extra_fields", "db: caller; callee; dialled")
modparam("acc", "extra_fields", "evi: caller; callee; dialled")

#### Trunks (step 6, ADR 0016): the Gateway writes the operator's servers (`dispatcher`), the registrations
#### (`registrant`), our `trunks` and `dids` (read at each external call through sqlops) and the numbering plan
#### (`dialplan`), then asks for ds_reload, reg_reload and dp_reload through the MI.
loadmodule "dispatcher.so"
modparam("dispatcher", "db_url", "${OPENSIPS_DB_URL}")
# An OPTIONS every 15 s to each server of the operator, from the trunk socket: it keeps the NAT open towards each
# (one may call while we registered with the other) and tells the ones down (3 unanswered in a row, then probed until
# one is answered); any answer from the server means it lives. Not the 408 tm makes up when none comes: in the list,
# it would keep a dead server up. Their state is never written back: the table is the Gateway's.
modparam("dispatcher", "ds_ping_interval", 15)
modparam("dispatcher", "ds_probing_threshold", 3)
modparam("dispatcher", "ds_probing_mode", 0)
modparam("dispatcher", "ds_ping_from", "sip:keepalive@${SIP_DOMAIN}")
modparam("dispatcher", "ds_probing_sock", "udp:${TRUNK_LISTEN_IP}:${TRUNK_PORT}")
modparam("dispatcher", "options_reply_codes", "401,403,404,405,407,500,501,503")
modparam("dispatcher", "persistent_state", 0)
loadmodule "dialplan.so"
modparam("dialplan", "db_url", "${OPENSIPS_DB_URL}")
# The trunk's credentials, read with it for each outbound call (route[trunk_out]): uac_auth() answers the operator's
# challenge with them (the password may be the HA1 of its realm, "0x" and 32 hex digits).
loadmodule "uac_auth.so"
modparam("uac_auth", "auth_username_avp", "$avp(t_user)")
modparam("uac_auth", "auth_password_avp", "$avp(t_pass)")
modparam("uac_auth", "auth_realm_avp", "$avp(t_realm)")
# The registrations to the operator, refreshed before they expire; one refused is tried again after 5 minutes only
# (an operator stops answering an address that registers too often, ARCHITECTURE §13).
loadmodule "uac_registrant.so"
modparam("uac_registrant", "db_url", "${OPENSIPS_DB_URL}")
modparam("uac_registrant", "timer_interval", 10)
modparam("uac_registrant", "failure_retry_interval", 300)
# The default trunk as last read (timer_route[default_trunk]): what an emergency call takes when the database cannot
# say (route[default_trunk]). None until read.
modparam("cfgutils", "shvset", "dt_setid=i:0")

#### Routing ###########################################################################################################

# Towards a browser: DTLS-SRTP (RTP/SAVPF), rtcp-mux, ICE with rtpengine as the only candidate (the browsers never see
# each other's address, and a browser behind a NAT still works), SDP origin and connection rewritten. Towards the
# operator (step 6): plain RTP (RTP/AVP, no ICE, no DTLS nor SDES, RTCP on its own port), only the trunk's codecs
# and DTMF events ($dlg_val(codecs)); a call from the operator offers the browser rtcp-mux and a=mid, as it expects.
# SIP INFO (DTMF) and the other in-dialog requests pass untouched.
route[rtp_flags] {
	$var(rtp_flags) = "ICE=force RTP/SAVPF rtcp-mux-require replace-origin replace-session-connection";
	if ($param(1) == 1)
		$var(rtp_flags) = "ICE=remove RTP/AVP rtcp-mux-demux DTLS=off SDES-off replace-origin replace-session-connection " + $dlg_val(codecs);
	else if ($dlg_val(trunk) != NULL)
		$var(rtp_flags) = "ICE=force RTP/SAVPF rtcp-mux-require generate-mid SDES-off replace-origin replace-session-connection";
}

# Whether the request in hand goes to the operator (1) or to a browser (-1): the trunk is the callee of an outbound
# call, the caller of an inbound one ($dlg_val(trunk)); an in-dialog request goes downstream (to the callee) or
# upstream (rr's ftag).
route[to_trunk] {
	if ($dlg_val(trunk) == NULL)
		return(-1);
	if (!has_totag() || is_direction("downstream")) {
		if ($dlg_val(trunk) == "callee")
			return(1);
		return(-1);
	}
	if ($dlg_val(trunk) == "caller")
		return(1);
	return(-1);
}

route[rtp_offer] {
	# The offer's side, for its answer (onreply_route[rtp]: it goes the other way).
	$(avp(offer_to_trunk)[*]) = NULL;
	$avp(offer_to_trunk) = 0;
	if (route(to_trunk))
		$avp(offer_to_trunk) = 1;
	route(rtp_flags, $avp(offer_to_trunk));
	if (!rtpengine_offer("$var(rtp_flags)")) {
		# Never relay the browser's own SDP: without rtpengine the call would go browser to browser.
		xlog("L_ERR", "rtpengine offer failed for $ci\n");
		send_reply(503, "Media Unavailable");
		exit;
	}
	# A session rtpengine holds for this call: a refusal after it (failure_route) frees it.
	$avp(rtp_on) = 1;
}
# An answer in a reply goes back the way its offer came ($param(1) unset); one in an ACK goes the way of the request
# ($param(1): 1 to the operator, 0 to a browser).
route[rtp_answer] {
	$var(answer_to_trunk) = 0;
	if ($param(1) != NULL)
		$var(answer_to_trunk) = $param(1);
	else if ($dlg_val(trunk) != NULL && $avp(offer_to_trunk) != 1)
		$var(answer_to_trunk) = 1;
	route(rtp_flags, $var(answer_to_trunk));
	if (!rtpengine_answer("$var(rtp_flags)"))
		xlog("L_ERR", "rtpengine answer failed for $ci\n");
}

# An INVITE without SDP (a "late offer", RFC 3264: an operator refreshing its session, or calling that way): the offer
# comes in the 2xx, back to whoever sent the INVITE, and the answer in the ACK. Both go through rtpengine
# (onreply_route[rtp], then the in-dialog ACK in the main route), never from one side to the other untouched.
route[late_offer] {
	$(avp(late_offer)[*]) = NULL;
	$avp(late_offer) = "browser";
	if ($dlg_val(trunk) != NULL && !route(to_trunk))
		$avp(late_offer) = "trunk";
}
route[rtp_late_offer] {
	$var(offer_to_trunk) = 0;
	if ($avp(late_offer) == "trunk")
		$var(offer_to_trunk) = 1;
	route(rtp_flags, $var(offer_to_trunk));
	if (rtpengine_offer("$var(rtp_flags)")) {
		$avp(rtp_on) = 1;
		$dlg_val(late_answer) = "1";
	} else {
		xlog("L_ERR", "rtpengine offer (in a 2xx) failed for $ci\n");
	}
}

route {
	if (!mf_process_maxfwd_header(10)) {
		send_reply(483, "Too Many Hops");
		exit;
	}

	# The trunk socket (step 6) hears the operator only: an address of its servers, or one its trunk declares
	# (`dispatcher`, any set, any port). From any other address, only a request in a call with the operator that is
	# under way (below: our Record-Route, a dialog of ours with the trunk, Call-ID and tags), as an operator's media
	# gateway or SBC sends its BYE or re-INVITE; anything else is refused.
	$var(stranger) = 0;
	if ($socket_in(ip) == "${TRUNK_LISTEN_IP}" && $socket_in(port) == ${TRUNK_PORT} && !ds_is_in_list("$si", 0)) {
		if (!has_totag()) {
			xlog("L_NOTICE", "trunk: $rm from $si:$sp refused, no address of the operator\n");
			if (!is_method("ACK"))
				send_reply(403, "Forbidden");
			exit;
		}
		$var(stranger) = 1;
	}

	# In-dialog requests (ACK, BYE, re-INVITE for hold, INFO, REFER...) follow the Record-Route.
	if (has_totag()) {
		if (is_method("ACK") && $var(stranger) == 0 && t_check_trans()) {
			if (has_body_part("application/sdp")) {
				$var(ack_to_trunk) = 0;
				if (route(to_trunk))
					$var(ack_to_trunk) = 1;
				route(rtp_answer, $var(ack_to_trunk));
			}
			t_relay();
			exit;
		}
		if (!loose_route()) {
			if ($var(stranger) == 1)
				xlog("L_NOTICE", "trunk: $rm from $si:$sp refused, no address of the operator\n");
			if ($var(stranger) == 1 && !is_method("ACK"))
				send_reply(403, "Forbidden");
			else if (!is_method("ACK"))
				send_reply(404, "Not Here");
			exit;
		}
		# Only a dialog this proxy created (an authenticated INVITE between two of its accounts) goes further:
		# a forged To-tag plus a Route naming us would otherwise turn loose_route() into an open relay.
		if (!match_dialog()) {
			if ($var(stranger) == 1)
				xlog("L_NOTICE", "trunk: $rm from $si:$sp refused, no call of the operator\n");
			if ($var(stranger) == 1 && !is_method("ACK"))
				send_reply(403, "Forbidden");
			else if (!is_method("ACK"))
				send_reply(481, "Call/Transaction Does Not Exist");
			exit;
		}
		# From an address the trunk does not declare: only the operator's side of one of its calls.
		if ($var(stranger) == 1) {
			if ($dlg_val(trunk) == NULL || route(to_trunk)) {
				xlog("L_NOTICE", "trunk: $rm from $si:$sp refused, in no call with the operator\n");
				if (!is_method("ACK"))
					send_reply(403, "Forbidden");
				exit;
			}
			xlog("L_NOTICE", "trunk: $rm of call $ci from $si:$sp, an address the trunk does not declare (accepted in this call)\n");
		}
		if (!is_method("INVITE|UPDATE|ACK|BYE|INFO|REFER|NOTIFY|PRACK|OPTIONS")) {
			send_reply(405, "Method Not Allowed");
			exit;
		}
		# Nothing in a call with the operator may have it place a call (step 6a, ADR 0016): a REFER (a transfer) would
		# have it call whatever the Refer-To says, on our account and past route[outbound_policy]. Refused whichever
		# side sends it: a transfer with an external party waits for one the platform makes itself.
		if (is_method("REFER") && $dlg_val(trunk) != NULL) {
			xlog("L_NOTICE", "call $ci: REFER in a call with the operator refused\n");
			if (route(to_trunk))
				append_to_reply("Twake-Call-Refused: transfer-external\r\n");
			send_reply(403, "Transfer Not Allowed");
			exit;
		}
		# A browser's Contact names a ".invalid" host (RFC 7118): point it at the WebSocket it came from, so the
		# other side's in-dialog requests reach it on that same connection.
		fix_nated_contact();
		if (is_method("INVITE|UPDATE") && has_body_part("application/sdp")) {
			route(rtp_offer);
			t_on_reply("rtp");
		} else if (is_method("INVITE")) {
			route(late_offer);
			t_on_reply("rtp");
		}
		# The answer to an offer made in a 2xx (route[rtp_late_offer]).
		if (is_method("ACK") && $dlg_val(late_answer) == "1" && has_body_part("application/sdp")) {
			$dlg_val(late_answer) = "0";
			$var(ack_to_trunk) = 0;
			if (route(to_trunk))
				$var(ack_to_trunk) = 1;
			route(rtp_answer, $var(ack_to_trunk));
		}
		if (is_method("BYE"))
			rtpengine_delete();
		# Who the parties are was said once, by this script, in the initial INVITE and its answer.
		remove_hf("P-Asserted-Identity");
		remove_hf("P-Preferred-Identity");
		remove_hf("Remote-Party-ID");
		# To the operator, only what a call needs (route[trunk_headers]).
		if (route(to_trunk))
			route(trunk_headers);
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

	# The trunk socket (step 6): the operator's requests only, its calls to our direct numbers.
	if ($socket_in(ip) == "${TRUNK_LISTEN_IP}" && $socket_in(port) == ${TRUNK_PORT}) {
		route(trunk_in);
		exit;
	}

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
	# Who calls is told by this script only (the From's display, route[caller_name]): no identity a phone asserts
	# passes on.
	remove_hf("P-Asserted-Identity");
	remove_hf("P-Preferred-Identity");
	remove_hf("Remote-Party-ID");

	if ($rU == NULL) {
		send_reply(484, "Address Incomplete");
		exit;
	}

	# A number of the public network (step 6, ADR 0016): normalised to E.164 and classified by the numbering plan
	# (`dialplan`); only what route[outbound_policy] allows goes to the operator. An emergency number goes to it
	# whatever extension or group could have its digits. Anything else is an extension or a group, as before.
	$var(pstn) = 0;
	if (!is_present_hf("Replaces") && dp_translate(1, "$rU", $var(num), $var(num_class)))
		route(outbound_policy);

	# The INVITE that completes an attended transfer (Replaces) goes where the call it replaces went: the extension
	# named in it may have forwarded that call elsewhere (the transferor dialled 104, 104's rules took it to 103).
	# Never into a call with the operator (step 6a): the platform does not transfer external parties yet.
	$var(replaces_to) = "";
	$var(replaces_trunk) = 0;
	if (is_present_hf("Replaces"))
		route(replaces_target);
	if ($var(replaces_trunk) == 1) {
		xlog("L_NOTICE", "call $ci: Replaces of a call with the operator refused\n");
		append_to_reply("Twake-Call-Refused: transfer-external\r\n");
		send_reply(403, "Transfer Not Allowed");
		exit;
	}

	record_route();
	fix_nated_contact();
	# A call to the operator: its caller's phone is asked whether it is still there (P), and the call ends by itself
	# past its longest duration (route[trunk_out_loaded]): BYE to both.
	if ($var(pstn) == 1)
		create_dialog("BP");
	else
		create_dialog();

	# Who calls whom, as dialled (the Request-URI changes with the lookup): for the CDR and the events. `callee` is
	# where the call goes now (the callee's rules may move it), `dialled` stays what the caller dialled.
	$avp(caller) = $fU;
	$avp(callee) = $rU;
	$avp(dialled) = $rU;
	$avp(domain) = $rd;
	$acc_extra(caller) = $fU;
	# acc's `callee` is the extension the call reached (route[forward_to] moves it): the one that rang, answered or
	# refused, as the Gateway counts it; `dialled` is what the caller dialled, as in the events.
	$acc_extra(callee) = $rU;
	$acc_extra(dialled) = $rU;
	# The missed call is accounted once nothing can forward the call any more (route[arm_failure]): acc reports the
	# first failure only, and a forward on busy or no answer comes after that failure.
	if ($var(pstn) == 1) {
		$(avp(callee)[*]) = NULL;
		$(avp(dialled)[*]) = NULL;
		$avp(callee) = $var(num);
		$avp(dialled) = $var(num);
		$avp(num_class) = $var(num_class);
		$acc_extra(callee) = $var(num);
		$acc_extra(dialled) = $var(num);
	}
	do_accounting("db|evi", "cdr");
	$avp(fwd_hops) = 0;
	$avp(fwd_seen) = "," + $rU + ",";

	# The transaction now, whatever path the call takes: every refusal below is a t_reply (accounted by acc), and a
	# relay that cannot send returns -6 to route[relay_call] instead of being answered by tm on its own.
	if (!t_newtran()) {
		sl_reply_error();
		exit;
	}

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
		# The names of both parties (route[names_loaded] rings).
		route(names_next);
		exit;
	}

	# To the operator: its trunk and the number presented are read without holding this process.
	if ($var(pstn) == 1) {
		route(trunk_out);
		exit;
	}

	# The callee's rules (immediate forward, "do not disturb"), followed from extension to extension, then every
	# registered window of the extension reached rings: route[rules_next] reads them without holding this process.
	route(rules_next);
	exit;
}

#### Trunks (step 6, ADR 0016) #########################################################################################
# What may go out, in 6a (numbering.ts): the emergency numbers, always, as dialled (route[trunk_out_loaded]); the
# European harmonised numbers (116xxx, free), as dialled, as far as the trunk calls free numbers; the fixed, mobile,
# free, standard-rate, overseas and international numbers, as far as the trunk allows them (its `allowed`: by default
# the metropolitan fixed, mobile, free and standard-rate ones, OUTBOUND_ALLOWED; an international number only to the
# country codes its `countries` lists); premium numbers never, satellite and international premium ones included
# (6b: rights per profile, caps, fraud_detection). A refusal comes before any transaction, with its reason for the app
# in Twake-Call-Refused; a malformed number is 484. $var(num) is the number in E.164 (a short one as dialled); sets
# $var(pstn) when it may go to the trunk.
route[outbound_policy] {
	if ($var(num_class) == "emergency") {
		$var(pstn) = 1;
		return(1);
	}
	if ($var(num_class) == "e164" && !dp_translate(2, "$var(num)", $var(num_kind), $var(num_class)))
		$var(num_class) = "invalid";
	switch ($var(num_class)) {
		case "fixed":
		case "mobile":
		case "freephone":
		case "standard-rate":
		case "overseas":
		case "international":
			$var(pstn) = 1;
			return(1);
		case "invalid":
			append_to_reply("Twake-Call-Refused: invalid\r\n");
			send_reply(484, "Address Incomplete");
			exit;
	}
	xlog("L_NOTICE", "call $ci: $fU to $var(num) refused ($var(num_class))\n");
	append_to_reply("Twake-Call-Refused: $var(num_class)\r\n");
	send_reply(403, "Destination Not Allowed");
	exit;
}

# The trunk of the caller's direct number, and that number to present; else the first trunk (the default one) and its
# own number. With them, what the trunk may call (`allowed`, `countries`) and, when the number called is one of our
# own direct numbers, the extension or group it rings (`internal`: the call stays inside, never through the
# operator). The caller is one of our accounts (digest), its user name has only the characters of `subscriber`; the
# number called, digits and a +.
route[trunk_out] {
	$var(ext) = "";
	if ($avp(caller) =~ "^[A-Za-z0-9._+-]{1,64}$")
		$var(ext) = $avp(caller);
	$var(called) = "";
	if ($avp(callee) =~ "^\+?[0-9]{2,16}$")
		$var(called) = $avp(callee);
	$var(trunk_query) = "SELECT t.setid, t.domain, t.number_format, t.assert_identity, t.auth_username, t.auth_password, t.auth_realm, t.codec_flags, coalesce(d.number, t.default_number) AS presented, t.allowed, t.countries, (SELECT CASE WHEN i.suffix_digits > 0 THEN right('" + $var(called) + "', i.suffix_digits) ELSE i.target END FROM dids i WHERE length(i.first_number) = length('" + $var(called) + "') AND '" + $var(called) + "' BETWEEN i.first_number AND i.last_number ORDER BY i.suffix_digits LIMIT 1) AS internal FROM trunks t LEFT JOIN LATERAL (SELECT CASE WHEN x.suffix_digits > 0 THEN left(x.first_number, length(x.first_number) - x.suffix_digits) || '" + $var(ext) + "' ELSE x.first_number END AS number FROM dids x WHERE x.trunk_id = t.id AND ((x.suffix_digits = 0 AND x.target = '" + $var(ext) + "') OR (x.suffix_digits = length('" + $var(ext) + "') AND left(x.first_number, length(x.first_number) - x.suffix_digits) || '" + $var(ext) + "' BETWEEN x.first_number AND x.last_number)) ORDER BY x.suffix_digits, x.first_number LIMIT 1) d ON true ORDER BY (d.number IS NULL), t.position LIMIT 1";
	async(sql_query_one("$var(trunk_query)", "$avp(t_setid);$avp(t_domain);$avp(t_format);$avp(t_pai);$avp(t_user);$avp(t_pass);$avp(t_realm);$avp(t_codecs);$avp(t_presented);$avp(t_allowed);$avp(t_countries);$avp(t_internal)"), trunk_out_loaded);
}

# An emergency call must not depend on the database (ADR 0016): the default trunk as this process last read it
# (timer_route[default_trunk], every 15 s), whatever the database says now. Its servers are in OpenSIPS's memory
# (dispatcher). Taken when the trunk of the call could not be read, or when none of its servers is up and the default
# trunk is another one; its own number presented. Returns -1 when it has none, or it is the trunk tried already.
route[default_trunk] {
	if ($shv(dt_setid) == 0 || ($avp(t_setid) != NULL && $avp(t_setid) == $shv(dt_setid)))
		return(-1);
	$(avp(t_setid)[*]) = NULL;
	$(avp(t_domain)[*]) = NULL;
	$(avp(t_format)[*]) = NULL;
	$(avp(t_pai)[*]) = NULL;
	$(avp(t_user)[*]) = NULL;
	$(avp(t_pass)[*]) = NULL;
	$(avp(t_realm)[*]) = NULL;
	$(avp(t_codecs)[*]) = NULL;
	$(avp(t_presented)[*]) = NULL;
	$avp(t_setid) = $shv(dt_setid);
	$avp(t_domain) = $shv(dt_domain);
	$avp(t_format) = $shv(dt_format);
	$avp(t_pai) = $shv(dt_pai);
	$avp(t_user) = $shv(dt_user);
	$avp(t_pass) = $shv(dt_pass);
	$avp(t_realm) = $shv(dt_realm);
	$avp(t_codecs) = $shv(dt_codecs);
	$avp(t_presented) = $shv(dt_number);
	return(1);
}
timer_route[default_trunk, 15] {
	if (sql_query_one("SELECT setid, domain, number_format, assert_identity, auth_username, auth_password, auth_realm, codec_flags, default_number FROM trunks ORDER BY position LIMIT 1", "$var(d_setid);$var(d_domain);$var(d_format);$var(d_pai);$var(d_user);$var(d_pass);$var(d_realm);$var(d_codecs);$var(d_number)")) {
		$shv(dt_domain) = $var(d_domain);
		$shv(dt_format) = $var(d_format);
		$shv(dt_pai) = $var(d_pai);
		$shv(dt_user) = $var(d_user);
		$shv(dt_pass) = $var(d_pass);
		$shv(dt_realm) = $var(d_realm);
		$shv(dt_codecs) = $var(d_codecs);
		$shv(dt_number) = $var(d_number);
		$shv(dt_setid) = $var(d_setid);
	} else if ($rc == -2) {
		# No trunk any more.
		$shv(dt_setid) = 0;
	}
}

# Every final failure of an emergency call tells the caller to call from another phone (Twake-Call-Refused:
# emergency), whatever the reason: no trunk, none of its servers up, the database, the operator's refusal.
route[emergency_failed] {
	xlog("L_WARN", "call $ci: emergency call from $avp(caller) to $avp(callee) failed ($param(1))\n");
	append_to_reply("Twake-Call-Refused: emergency\r\n");
	t_reply(503, "Emergency Call Failed");
}

route[trunk_out_loaded] {
	$var(trunk_rc) = $rc;
	if (t_was_cancelled()) {
		t_reply(487, "Request Terminated");
		exit;
	}
	if ($var(trunk_rc) == -2) {
		# No trunk at all: the caller is told to call an emergency number from another phone.
		if ($avp(num_class) == "emergency") {
			append_to_reply("Twake-Call-Refused: emergency\r\n");
			t_reply(403, "Emergency Calls Not Routed");
			exit;
		}
		append_to_reply("Twake-Call-Refused: no-trunk\r\n");
		t_reply(503, "No Trunk");
		exit;
	}
	if ($var(trunk_rc) < 0) {
		xlog("L_WARN", "call $ci: trunk not read ($var(trunk_rc))\n");
		if ($avp(num_class) == "emergency" && route(default_trunk)) {
			xlog("L_WARN", "call $ci: emergency call through the default trunk as last read\n");
		} else if ($avp(num_class) == "emergency") {
			route(emergency_failed, "no trunk read");
			exit;
		} else {
			append_to_reply("Twake-Call-Refused: no-trunk\r\n");
			t_reply(503, "Service Unavailable");
			exit;
		}
	}
	# One of our own direct numbers: the extension or group it rings, as if dialled, never through the operator.
	if ($avp(t_internal) != NULL && $avp(t_internal) =~ "^[A-Za-z0-9._+-]{1,64}$") {
		xlog("L_INFO", "call $ci: $avp(callee) is a direct number of ours, it rings $avp(t_internal)\n");
		$var(internal) = $avp(t_internal);
		$ru = "sip:" + $var(internal) + "@" + $avp(domain);
		$(avp(callee)[*]) = NULL;
		$avp(callee) = $var(internal);
		$acc_extra(callee) = $var(internal);
		$(avp(fwd_seen)[*]) = NULL;
		$avp(fwd_seen) = "," + $var(internal) + ",";
		route(rules_next);
		exit;
	}
	# What the trunk may call: an emergency number always, anything else as its `allowed` says (",fixed,mobile,"),
	# an international number only to a country code its `countries` lists (",32,44,": E.164 country codes, of one to
	# three digits, are none the start of another).
	if ($avp(num_class) != "emergency") {
		$var(mark) = "," + $avp(num_class) + ",";
		$var(allowed) = 1;
		if ($avp(t_allowed) == NULL || $(avp(t_allowed){s.index,$var(mark)}) == NULL)
			$var(allowed) = 0;
		if ($avp(num_class) == "international" && $var(allowed) == 1) {
			$var(allowed) = 0;
			$var(i) = 1;
			while ($var(i) <= 3) {
				$var(cc) = "," + $(avp(callee){s.substr,1,$var(i)}) + ",";
				if ($avp(t_countries) != NULL && $(avp(t_countries){s.index,$var(cc)}) != NULL)
					$var(allowed) = 1;
				$var(i) = $var(i) + 1;
			}
		}
		if ($var(allowed) == 0) {
			xlog("L_NOTICE", "call $ci: $avp(caller) to $avp(callee) refused ($avp(num_class), not allowed on the trunk)\n");
			append_to_reply("Twake-Call-Refused: $avp(num_class)\r\n");
			t_reply(403, "Destination Not Allowed");
			exit;
		}
	}
	# The operator's first server up (failover to the next ones: failure_route[trunk_failed]); for an emergency call,
	# the default trunk's when none of this one's is up.
	if (!ds_select_dst($avp(t_setid), 8, "f")) {
		xlog("L_WARN", "call $ci: no server of the trunk is up\n");
		if ($avp(num_class) != "emergency") {
			append_to_reply("Twake-Call-Refused: no-trunk\r\n");
			t_reply(503, "Trunk Unavailable");
			exit;
		}
		if (!route(default_trunk) || !ds_select_dst($avp(t_setid), 8, "f")) {
			route(emergency_failed, "no server up");
			exit;
		}
	}
	$socket_out = "udp:${TRUNK_LISTEN_IP}:${TRUNK_PORT}";
	# The numbers as the operator wants them written; a short one (112, 15, 116006...) as dialled.
	$var(to_user) = $avp(callee);
	if ($avp(callee) =~ "^\+") {
		route(trunk_number, $avp(callee));
		$var(to_user) = $var(trunk_number);
	}
	route(trunk_number, $avp(t_presented));
	$var(from_user) = $var(trunk_number);
	$ru = "sip:" + $var(to_user) + "@" + $avp(t_domain);
	# Kept for failure_route[trunk_failed]: a failure route starts again from the Request-URI the call came with.
	$(avp(t_ruri)[*]) = NULL;
	$avp(t_ruri) = $ru;
	# Only what a call needs goes to the operator (route[trunk_headers]); who calls, for it: the number presented, never
	# a name of the directory nor the extension; whom: the number as it writes them, at its domain (not what the caller
	# dialled, nor our address).
	route(trunk_headers);
	uac_replace_from("", "sip:$var(from_user)@$avp(t_domain)");
	uac_replace_to("", "sip:$var(to_user)@$avp(t_domain)");
	if ($avp(t_pai) == 1)
		append_hf("P-Asserted-Identity: <sip:$var(from_user)@$avp(t_domain)>\r\n");
	# An emergency call lasts as long as its parties are there (the phone answers the dialog's OPTIONS): never cut at
	# TRUNK_MAX_CALL_SEC. A week bounds what the dialog module keeps.
	if ($avp(num_class) == "emergency")
		$DLG_timeout = 604800;
	else
		$DLG_timeout = ${TRUNK_MAX_CALL_SEC};
	$(avp(t_rang)[*]) = NULL;
	$dlg_val(trunk) = "callee";
	$dlg_val(codecs) = $avp(t_codecs);
	$dlg_val(callee) = $avp(callee);
	$dlg_val(dialled) = $avp(dialled);
	# A call without SDP (a SIP phone's late offer): the operator's offer in its 2xx, through rtpengine, to the phone,
	# whose answer in the ACK goes through it too (route[rtp_late_offer]), never the operator's own SDP.
	if (has_body_part("application/sdp")) {
		route(rtp_offer);
	} else {
		$(avp(late_offer)[*]) = NULL;
		$avp(late_offer) = "browser";
	}
	t_on_reply("rtp");
	t_on_failure("trunk_failed");
	route(calling);
	if (!t_relay()) {
		rtpengine_delete();
		route(account_missed);
		if ($avp(num_class) == "emergency") {
			route(emergency_failed, "not sent");
			exit;
		}
		t_reply(503, "Trunk Unavailable");
	}
	exit;
}

# What goes to the operator in a request of ours: only the headers a call needs, every other one a phone may have set
# removed (identity and billing: Diversion, History-Info, P-Charge-Info, P-Called-Party-ID, P-Preferred-Service,
# Privacy, Remote-Party-ID, Referred-By, X-*...; its make, User-Agent): the operator reads who calls and who pays from
# this script only (the From, and the P-Asserted-Identity it adds when the trunk says so). Compact forms included.
route[trunk_headers] {
	$var(h) = 0;
	while ($(hdr_name[$var(h)]) != NULL) {
		$var(name) = $(hdr_name[$var(h)]{s.tolower});
		if (!($var(name) =~ "^(via|v|max-forwards|from|f|to|t|call-id|i|cseq|contact|m|route|content-type|c|content-length|l|content-disposition|allow|supported|k|require|session-expires|x|min-se|accept|rack|rseq|event|o|subscription-state|mime-version)$"))
			remove_hf("$var(name)");
		$var(h) = $var(h) + 1;
	}
}

# $param(1), in E.164, as the trunk writes numbers ($avp(t_format)), in $var(trunk_number).
route[trunk_number] {
	$var(trunk_number) = $param(1);
	switch ($avp(t_format)) {
		case "e164-no-plus":
			$var(trunk_number) = $(param(1){s.substr,1,0});
			break;
		case "international-00":
			$var(trunk_number) = "00" + $(param(1){s.substr,1,0});
			break;
		case "national":
			if ($param(1) =~ "^\+33")
				$var(trunk_number) = "0" + $(param(1){s.substr,3,0});
			else
				$var(trunk_number) = "00" + $(param(1){s.substr,1,0});
			break;
	}
}

# A call to the operator that failed. Its challenge (401, 407) is answered once per server with the trunk's
# credentials (the realm it names when the trunk does not say); one it challenges again, or that cannot be answered
# (no password), is a trunk that does not work: 503 with Twake-Call-Refused: no-trunk, never the operator's challenge
# (the browser would answer it with its own credentials). A server that did not answer at all (408) or is out of order
# (5xx) before the person was called (no 180 or 183 yet, $avp(t_rang); a 100 Trying says nothing of that): the next
# one. Once the person's phone rang, the call stays with that server: another one would call the person again. A
# redirection (3xx) is not followed and its Contact never reaches the phone: 480. An emergency call that does not go
# through tells the caller to call from another phone (route[emergency_failed]). A call that does not go through is
# accounted here, once nothing retries it (acc would report the challenge otherwise): the caller's history tells how
# it ended.
failure_route[trunk_failed] {
	if (t_was_cancelled()) {
		rtpengine_delete();
		route(account_missed);
		exit;
	}
	# The number at the operator's domain, as route[trunk_out_loaded] wrote it (here $ru is the one dialled again).
	$ru = $avp(t_ruri);
	if (t_check_status("401|407")) {
		if ($avp(t_challenged) == NULL && $avp(t_pass) != NULL && $avp(t_pass) != "") {
			$avp(t_challenged) = 1;
			if ($avp(t_realm) == NULL || $avp(t_realm) == "") {
				$var(challenge) = $(<reply>hdr(WWW-Authenticate));
				if ($T_reply_code == 407)
					$var(challenge) = $(<reply>hdr(Proxy-Authenticate));
				$(avp(t_realm)[*]) = NULL;
				$avp(t_realm) = $(var(challenge){re.subst,/^.*realm="([^"]*)".*$/\1/});
			}
			if (uac_auth()) {
				$du = $avp(ds_dst_failover);
				$socket_out = "udp:${TRUNK_LISTEN_IP}:${TRUNK_PORT}";
				$(avp(t_rang)[*]) = NULL;
				t_on_reply("rtp");
				t_on_failure("trunk_failed");
				if (t_relay())
					exit;
			}
		}
		xlog("L_WARN", "call $ci: the operator's challenge ($T_reply_code) could not be answered: check the trunk's login, password and realm\n");
		rtpengine_delete();
		route(account_missed);
		if ($avp(num_class) == "emergency") {
			route(emergency_failed, "challenge not answered");
			exit;
		}
		append_to_reply("Twake-Call-Refused: no-trunk\r\n");
		t_reply(503, "Trunk Authentication Failed");
		exit;
	}
	if (t_check_status("408|5[0-9][0-9]") && $avp(t_rang) == NULL && ds_next_dst()) {
		xlog("L_NOTICE", "call $ci: trunk server failed ($T_reply_code), next one $du\n");
		$socket_out = "udp:${TRUNK_LISTEN_IP}:${TRUNK_PORT}";
		$(avp(t_challenged)[*]) = NULL;
		$(avp(t_rang)[*]) = NULL;
		t_on_reply("rtp");
		t_on_failure("trunk_failed");
		if (t_relay())
			exit;
	}
	rtpengine_delete();
	route(account_missed);
	if ($avp(num_class) == "emergency") {
		$var(failed) = "" + $T_reply_code;
		route(emergency_failed, $var(failed));
		exit;
	}
	if (t_check_status("3[0-9][0-9]")) {
		xlog("L_NOTICE", "call $ci: the operator redirected the call ($T_reply_code), not followed\n");
		t_reply(480, "Temporarily Unavailable");
	}
}

# A request on the trunk socket, from the operator (the main route refused any other address). Its calls reach the
# extension or group of the direct number called (`dids`), in E.164: the Request-URI's, else the To's; the To's first
# when the Request-URI is the address a trunk registered (its user is the trunk's login, often its main number). Then
# the path of every call (route[rules_next]): forwards, "do not disturb", groups, the browsers to wake. The caller is
# its number in E.164, "anonymous" when it has none or asks not to be shown (Privacy: id or user, RFC 3323 and 3325):
# the browser sees nothing else of the From (route[caller_name]).
route[trunk_in] {
	if (is_method("ACK"))
		exit;
	if (is_method("OPTIONS")) {
		send_reply(200, "OK");
		exit;
	}
	if (!is_method("INVITE")) {
		send_reply(405, "Method Not Allowed");
		exit;
	}
	remove_hf("Route");
	remove_hf("P-Asserted-Identity");
	remove_hf("P-Preferred-Identity");
	remove_hf("Remote-Party-ID");
	$var(n1) = "";
	$var(n2) = "";
	if (route(inbound_number, $rU))
		$var(n1) = $var(inbound_number);
	if (route(inbound_number, $tU))
		$var(n2) = $var(inbound_number);
	if ($var(n1) == "" && $var(n2) == "") {
		send_reply(404, "Not Found");
		exit;
	}
	$var(from_number) = "anonymous";
	if (route(inbound_number, $fU))
		$var(from_number) = $var(inbound_number);
	# Every Privacy header, every value: `id` (the asserted identity) or `user` (the From) hides the caller.
	if (is_present_hf("Privacy")) {
		$var(privacy) = $(hdr(Privacy)[*]{s.tolower});
		if ($var(privacy) =~ "(^|[;, ])(id|user)([;, ]|$)")
			$var(from_number) = "anonymous";
	}
	record_route();
	# The phone that answers is asked whether it is still there (p); the call ends past its longest duration (B).
	create_dialog("Bp");
	$DLG_timeout = ${TRUNK_MAX_CALL_SEC};
	$dlg_val(trunk) = "caller";
	# A call without SDP: the browser that answers makes the offer (route[late_offer]).
	if (!has_body_part("application/sdp")) {
		$(avp(late_offer)[*]) = NULL;
		$avp(late_offer) = "trunk";
	}
	$avp(caller) = $var(from_number);
	$avp(caller_uri) = "sip:" + $var(from_number) + "@${SIP_DOMAIN}";
	if ($var(from_number) == "anonymous")
		$avp(caller_uri) = "sip:anonymous@anonymous.invalid";
	$avp(domain) = "${SIP_DOMAIN}";
	$acc_extra(caller) = $var(from_number);
	do_accounting("db|evi", "cdr");
	if (!t_newtran()) {
		sl_reply_error();
		exit;
	}
	# The Request-URI's number first, unless it is the user a trunk registers (the binding it calls): the To's then.
	$var(ru_user) = "";
	if ($rU =~ "^[A-Za-z0-9._+-]{1,64}$")
		$var(ru_user) = $rU;
	$var(did_query) = "SELECT CASE WHEN d.suffix_digits > 0 THEN right(n.num, d.suffix_digits) ELSE d.target END, t.codec_flags FROM (VALUES (CASE WHEN EXISTS (SELECT 1 FROM trunks b WHERE b.reg_aor <> '' AND b.auth_username = '" + $var(ru_user) + "') THEN 3 ELSE 1 END, '" + $var(n1) + "'), (2, '" + $var(n2) + "')) AS n(o, num) JOIN dids d ON length(d.first_number) = length(n.num) AND n.num BETWEEN d.first_number AND d.last_number JOIN trunks t ON t.id = d.trunk_id ORDER BY n.o, d.suffix_digits LIMIT 1";
	async(sql_query_one("$var(did_query)", "$avp(did_target);$avp(t_codecs)"), trunk_in_loaded);
}

# $param(1), a number the operator sent, in E.164 ($var(inbound_number)): as the numbering plan reads what is dialled
# (dpid 1), else in the forms only operators send (dpid 3, nine digits without the 0).
route[inbound_number] {
	$var(inbound_number) = "";
	if ($param(1) == NULL)
		return(-1);
	$var(in) = $param(1);
	if (!dp_translate(1, "$var(in)", $var(n), $var(n_class)) && !dp_translate(3, "$var(in)", $var(n), $var(n_class)))
		return(-1);
	if ($var(n_class) != "e164" || !($var(n) =~ "^\+[0-9]{7,15}$"))
		return(-1);
	$var(inbound_number) = $var(n);
	return(1);
}

route[trunk_in_loaded] {
	$var(did_rc) = $rc;
	if (t_was_cancelled()) {
		t_reply(487, "Request Terminated");
		exit;
	}
	if ($var(did_rc) < 0 && $var(did_rc) != -2)
		xlog("L_WARN", "call $ci: direct numbers not read ($var(did_rc))\n");
	if ($var(did_rc) < 0 || $avp(did_target) == NULL || !($avp(did_target) =~ "^[A-Za-z0-9._+-]{1,64}$")) {
		t_reply(404, "Not Found");
		exit;
	}
	$dlg_val(codecs) = $avp(t_codecs);
	$ru = "sip:" + $avp(did_target) + "@${SIP_DOMAIN}";
	$avp(callee) = $avp(did_target);
	$avp(dialled) = $avp(did_target);
	$acc_extra(callee) = $avp(did_target);
	$acc_extra(dialled) = $avp(did_target);
	$avp(fwd_hops) = 0;
	$avp(fwd_seen) = "," + $avp(did_target) + ",";
	route(rules_next);
	exit;
}

# The call rings the windows found by the lookup ($ru and the branches). When the extension it rings has a busy or a
# no-answer forward, the rules those forwards may lead to are read first, asynchronously (route[preload_query]): the
# failure of this ringing (failure_route) or of its relay (route[relay_call]) then decides from them, without a
# query. They are those of when the ringing starts: a change made while it rings applies to the next call.
route[ring] {
	if ($avp(fwd_hops) < 3 && ($avp(r_busy) != NULL || $avp(r_noanswer) != NULL) && route(preload_query)) {
		async(sql_query("$var(preload_query)", "$avp(p_ext);$avp(p_always);$avp(p_busy);$avp(p_noanswer);$avp(p_delay);$avp(p_dnd);$avp(p_message);$avp(p_retry);$avp(p_name)"), ring_loaded);
	} else {
		route(ring_now);
	}
}

route[ring_loaded] {
	# 1: rows; -2: none; any other failure (timeout, database down): the forwards' targets go without rules.
	$var(rules_rc) = $rc;
	if (t_was_cancelled())
		route(cancelled);
	if ($var(rules_rc) < 0 && $var(rules_rc) != -2 && route(read_failed)) {
		route(ring);
		exit;
	}
	$(avp(q_again)[*]) = NULL;
	if ($var(rules_rc) < 0 && $var(rules_rc) != -2)
		xlog("L_WARN", "call $ci: rules of the forwards of $avp(callee) not read ($var(rules_rc), twice), they go without them\n");
	route(ring_now);
	exit;
}

# Media offer (once per call: a forward after a failure sends the same offer on), then the relay. The extension it
# rings is kept in the dialog with the one dialled: an INVITE with Replaces for this call is sent there
# (route[replaces_target]).
route[ring_now] {
	$dlg_val(callee) = $avp(callee);
	$dlg_val(dialled) = $avp(dialled);
	if ($avp(rtp_on) == NULL && has_body_part("application/sdp"))
		route(rtp_offer);
	t_on_reply("rtp");
	t_on_failure("call_failed");
	t_on_branch("tried");
	route(arm_failure);
	# The call starts: told to the Gateway only now, once nothing can refuse it without a transaction: from here on,
	# acc tells how it ended.
	route(calling);
	# Nobody registered, a browser to wake (route[wake_loaded]): the call waits for it.
	if ($avp(wake) == 1)
		route(hold);
	# A ring group whose members with a window ring now, and whose members without one are woken (route[group_hold]).
	if ($avp(group) != NULL && $avp(g_woken) > 0 && $avp(g_windows) == 0)
		route(group_hold);
	# Relayed from the request route: windows that cannot be reached may still have a browser to wake (3; 4 for a
	# ring group).
	$var(relay_request) = 1;
	route(relay_call);
	$var(relayed) = $rc;
	if ($var(relayed) == 3)
		route(wake_next);
	if ($var(relayed) == 4)
		route(group_dead);
	if ($avp(group) != NULL && $avp(g_woken) > 0)
		route(group_hold);
}

# The caller cancelled while the rules were read (the transaction exists, so tm accepts its CANCEL, but nothing rang
# yet): no offer, no call told to the Gateway, a missed call for the extension dialled.
route[cancelled] {
	# The offer made before looking for a browser to wake (route[wake_next]) is over.
	if ($avp(rtp_on) != NULL)
		rtpengine_delete();
	route(account_missed);
	t_reply(487, "Request Terminated");
	exit;
}

#### Directory names (step 4c, ADR 0014) ###############################################################################
# `display_names` holds the name the directory gives each extension (the Gateway writes it at each synchronisation).
# The callee's phone shows the caller's in the From (route[caller_name]); the caller's phone shows the name of whoever
# answered, asserted in the 2xx (P-Asserted-Identity, onreply_route[rtp]): the callee's ($avp(r_name), read with its
# rules) or, for a ring group, the member's. Read in the queries that already run (the rules, the group's members);
# the Replaces INVITE, which reads no rules, has its own (route[names_next]). Neither double quote, backslash nor
# control character is read: a name only ever goes into a quoted display name. When the names cannot be read (the
# query failed, the tables are missing), the From stays as the phone sent it and the answer asserts the number only:
# a call never waits for or fails on a name. Read, the directory's name or none: never the phone's.

# The SQL expression of a name in `display_names` aliased n: one line, nothing that could end or escape its quoting.
route[name_sql] {
	$var(name_sql) = "regexp_replace(translate(n.display_name, chr(34) || chr(92), ''), '[[:cntrl:]]', '', 'g')";
}

# The INVITE with Replaces: the names of the caller and of the extension it reaches ($avp(callee)), then the ringing.
route[names_next] {
	$(avp(r_name)[*]) = NULL;
	$(avp(n_caller)[*]) = NULL;
	if (!route(tables_4c)) {
		route(caller_name);
		route(ring);
		exit;
	}
	$var(names_callee) = "";
	if ($avp(callee) =~ "^[A-Za-z0-9._+-]{1,64}$")
		$var(names_callee) = $avp(callee);
	$var(names_caller) = "";
	if ($avp(caller) =~ "^[A-Za-z0-9._+-]{1,64}$")
		$var(names_caller) = $avp(caller);
	route(name_sql);
	$var(names_query) = "SELECT (SELECT " + $var(name_sql) + " FROM display_names n WHERE n.extension = '" + $var(names_callee) + "'), (SELECT " + $var(name_sql) + " FROM display_names n WHERE n.extension = '" + $var(names_caller) + "')";
	$avp(q4c) = 1;
	async(sql_query_one("$var(names_query)", "$avp(r_name);$avp(n_caller)"), names_loaded);
}

route[names_loaded] {
	$var(names_rc) = $rc;
	if (t_was_cancelled())
		route(cancelled);
	if ($var(names_rc) < 0 && $var(names_rc) != -2 && route(read_failed)) {
		route(names_next);
		exit;
	}
	$(avp(q_again)[*]) = NULL;
	if ($var(names_rc) == 1)
		$avp(names_read) = 1;
	else
		xlog("L_WARN", "call $ci: names not read ($var(names_rc)), the From stays as the caller's phone sent it\n");
	route(caller_name);
	route(ring);
	exit;
}

# The caller as the directory names it, in the From the callee's phone shows, whatever the caller's phone put there:
# no name when the directory has none. Once per call, before the first relay. Left as it is: a From without angle
# brackets (where no display name can go), and when the names could not be read ($avp(names_read) unset).
route[caller_name] {
	if ($avp(named) != NULL)
		return(1);
	$avp(named) = 1;
	# A call from the operator: its caller as route[trunk_in] read it, without the operator's display name or domain.
	if ($avp(caller_uri) != NULL) {
		uac_replace_from("", "$avp(caller_uri)");
		return(1);
	}
	if ($avp(names_read) != 1)
		return(-1);
	if (!($hdr(From) =~ "<"))
		return(-1);
	$var(caller_name) = "";
	if ($avp(n_caller) != NULL)
		$var(caller_name) = $avp(n_caller);
	uac_replace_from("$var(caller_name)", "");
	return(1);
}

# Whether the queries may name the tables of step 4c: not for 30 s after the database said one is missing.
route[tables_4c] {
	if ($shv(no4c_until) > $Ts)
		return(-1);
	return(1);
}

# A read that failed: 1 to make it again (once per read), -1 to go on without it. When it named the tables of step 4c
# ($avp(q4c)) and the database says one is missing, they are left out for 30 s and the read goes again without them;
# otherwise (they exist, or the database cannot say) the same read goes again: a dropped connection is made anew.
route[read_failed] {
	if ($avp(q_again) == 1) {
		$(avp(q_again)[*]) = NULL;
		return(-1);
	}
	$avp(q_again) = 1;
	# `push_targets` (step 5) likewise: when the database says it is missing, nobody is woken for 30 s, and the read
	# goes again without it.
	if ($avp(q5) == 1 && route(table_5_missing)) {
		$shv(no5_until) = $Ts + 30;
		xlog("L_WARN", "call $ci: the database has no push_targets (the Gateway of step 5 creates it): nobody woken for 30 s\n");
		return(1);
	}
	if ($avp(q4c) == 1 && route(tables_4c_missing)) {
		$shv(no4c_until) = $Ts + 30;
		xlog("L_WARN", "call $ci: the database has no call_groups or display_names (the Gateway of step 4c creates them): ring groups and directory names left out for 30 s\n");
	} else {
		xlog("L_NOTICE", "call $ci: a read failed, made again once\n");
	}
	return(1);
}

# Whether the database says a table of step 4c is missing: a synchronous catalog query, only after a failed read
# (bounded by the statement_timeout as the others). -1 when it says they exist, or cannot say.
route[tables_4c_missing] {
	$var(missing) = 0;
	if (!sql_query_one("SELECT CASE WHEN to_regclass('call_groups') IS NULL OR to_regclass('display_names') IS NULL THEN 1 ELSE 0 END", "$var(missing)"))
		return(-1);
	if ($var(missing) == 1)
		return(1);
	return(-1);
}

# Whether the database says `push_targets` is missing (as route[tables_4c_missing]).
route[table_5_missing] {
	$var(missing) = 0;
	if (!sql_query_one("SELECT CASE WHEN to_regclass('push_targets') IS NULL THEN 1 ELSE 0 END", "$var(missing)"))
		return(-1);
	if ($var(missing) == 1)
		return(1);
	return(-1);
}

#### Calls to someone without a window (step 5, ADR 0015) ##############################################################
# The extension the call reaches ($avp(callee)) has no registered window. When its holder has a browser the Gateway
# can wake (a row of `push_targets`), the transaction waits for a window of theirs to register: the Gateway sends the
# push (E_TWAKEPHONE_WAKE), the notification opens the app, which registers, and that window rings in the same
# transaction (route[woken]). Only from the request route (a failure_route cannot hold a transaction), once per call;
# after the wait, the no-answer forward, or the failure as before (failure_route). The caller hears it ringing
# meanwhile (a 180 of ours).

# Whether $avp(callee) can be woken: one read, asynchronous as the others. The media offer is made first: the read
# keeps it in the transaction, and the branch of a window that registers is built from the request it keeps.
route[wake_next] {
	$avp(wake_checked) = $avp(callee);
	if ($shv(no5_until) > $Ts || !($avp(callee) =~ "^[A-Za-z0-9._+-]{1,64}$")) {
		route(not_woken);
		exit;
	}
	if ($avp(rtp_on) == NULL && has_body_part("application/sdp"))
		route(rtp_offer);
	$(avp(q4c)[*]) = NULL;
	$avp(q5) = 1;
	$(avp(wake_row)[*]) = NULL;
	$var(wake_query) = "SELECT 1 FROM push_targets WHERE extension = '" + $avp(callee) + "' AND alive_until > now()";
	async(sql_query_one("$var(wake_query)", "$avp(wake_row)"), wake_loaded);
}

route[wake_loaded] {
	# 1: a browser to wake; -2: none; any other failure (timeout, database down): read again once, then nobody woken.
	$var(wake_rc) = $rc;
	if (t_was_cancelled())
		route(cancelled);
	if ($var(wake_rc) < 0 && $var(wake_rc) != -2 && route(read_failed)) {
		route(wake_next);
		exit;
	}
	$(avp(q_again)[*]) = NULL;
	$(avp(q5)[*]) = NULL;
	if ($var(wake_rc) == 1) {
		$avp(wake) = 1;
		# The rules its forwards lead to, as for any ringing (route[ring]), then route[hold].
		route(ring);
		exit;
	}
	if ($var(wake_rc) < 0 && $var(wake_rc) != -2)
		xlog("L_WARN", "call $ci: whether $avp(callee) can be woken not read ($var(wake_rc), twice), not woken\n");
	route(not_woken);
	exit;
}

# Nobody to wake: on as before. Windows that could not be reached: the relay's failure (route[relay_failed]); none:
# the no-answer forward at once, or nobody to ring (route[rules_step], which no longer looks for a browser).
route[not_woken] {
	if ($avp(relay_dead) == 1) {
		$var(relay_rc) = -6;
		route(relay_failed);
	}
	route(rules_step);
	exit;
}

# The call waits for a window of $avp(callee): the no-answer delay when they have that forward (it goes when nobody
# answered within it), PUSH_WAIT_SEC otherwise. A phony branch keeps the transaction alive that long
# (t_wait_for_new_branches, armed with that delay): a CANCEL ends it at once (487), and its timeout (408) is the
# failure failure_route handles as a no answer. A window that registers meanwhile rings (route[woken]).
route[hold] {
	$var(wait) = ${PUSH_WAIT_SEC};
	if ($avp(r_noanswer) != NULL && $avp(r_delay) != NULL)
		$var(wait) = $avp(r_delay);
	$T_fr_inv_timeout = $var(wait);
	if ($avp(relay_dead) == 1)
		route(past_dead_branches);
	if (!t_wait_for_new_branches()) {
		xlog("L_ERR", "call $ci: cannot hold the call for a window of $avp(callee)\n");
		route(unreachable);
	}
	$avp(held) = 1;
	# The first window that rings ends the wait (branch_route[tried]).
	$avp(held_one) = 1;
	$(avp(wake_filter)[*]) = NULL;
	$avp(wake_filter) = "aor=" + $avp(callee);
	# A window that registers (INSERT), or one that comes back with the Contact it had (UPDATE: a tab whose WebSocket
	# died, a laptop woken up, reconnects with the same Contact on a new connection).
	$var(followed) = 0;
	if (notify_on_event("E_UL_CONTACT_INSERT", $avp(wake_filter), "woken", $var(wait)))
		$var(followed) = $var(followed) + 1;
	if (notify_on_event("E_UL_CONTACT_UPDATE", $avp(wake_filter), "woken", $var(wait)))
		$var(followed) = $var(followed) + 1;
	if ($var(followed) < 2)
		xlog("L_ERR", "call $ci: a window of $avp(callee) may not ring (notify_on_event failed), the call waits $var(wait) s\n");
	# A window that registered before the call followed the registrations (while it was read whether the callee can
	# be woken, or the rules of the forwards): it rings now, nobody is woken.
	if (route(registered_meanwhile))
		exit;
	route(event_attrs);
	$avp(ev_attr) = "wait";
	$avp(ev_val) = $var(wait);
	raise_event("E_TWAKEPHONE_WAKE", $avp(ev_attr), $avp(ev_val));
	t_reply(180, "Ringing");
	exit;
}

# The windows of $avp(callee) registered now that were not there when the call was relayed ($avp(seen_dst), the
# destinations tried then: those of windows on dead WebSockets): relayed, and the call no longer waits for another
# (t_wait_no_more_branches: the phony branch, just before them, stays in their set). 1 when one was sent. A window
# known already is not tried again: a second relay after the failed ones would start a set without the phony branch.
# A relay that fails after adding its branch (a WebSocket that died meanwhile) leaves it beside the phony branch: the
# set starts again past it, with a phony branch of its own (route[past_dead_branches]), so that a CANCEL still ends the
# call at once.
route[registered_meanwhile] {
	$var(aor) = "sip:" + $avp(callee) + "@" + $avp(domain);
	if (!lookup("location", "to-branches-only", "$var(aor)"))
		return(-1);
	# Index 0 of $msg.branch is the Request-URI (the callee's address): the windows are 1 to last_idx, and
	# remove_msg_branch() counts them from 0. From the last one, those tried already go.
	$var(b) = $msg.branch.last_idx;
	while ($var(b) >= 1) {
		$var(dst) = $(msg.branch.uri[$var(b)]);
		if ($(msg.branch.duri[$var(b)]) != NULL)
			$var(dst) = $(msg.branch.duri[$var(b)]);
		$var(mark) = " " + $var(dst) + " ";
		$var(i) = $var(b) - 1;
		if ($avp(seen_dst) != NULL && $(avp(seen_dst){s.index,$var(mark)}) != NULL)
			remove_msg_branch($var(i));
		$var(b) = $var(b) - 1;
	}
	if ($msg.branch.last_idx < 1)
		return(-1);
	# The first new window takes the Request-URI (the callee's address would come back here), the others stay branches.
	$ru = $(msg.branch.uri[1]);
	resetdsturi();
	if ($(msg.branch.duri[1]) != NULL)
		$du = $(msg.branch.duri[1]);
	if ($(msg.branch.path[1]) != NULL)
		$(msg.branch.path[0]) = $(msg.branch.path[1]);
	if ($(msg.branch.socket[1]) != NULL)
		$(msg.branch.socket[0]) = $(msg.branch.socket[1]);
	if ($(msg.branch.flags[1]) != NULL)
		$(msg.branch.flags[0]) = $(msg.branch.flags[1]);
	remove_msg_branch(0);
	xlog("L_NOTICE", "call $ci: a window of $avp(callee) registered while the call was set up, it rings\n");
	if (!t_relay()) {
		xlog("L_NOTICE", "call $ci: the window of $avp(callee) that registered meanwhile cannot be reached ($rc), the call waits\n");
		$ru = $var(aor);
		resetdsturi();
		# The last branch is a phony one when the relay added none (its URI is empty): it is still alone in the set.
		if ($(tm.branch.uri[-1]) != "") {
			route(past_dead_branches);
			if (!t_wait_for_new_branches()) {
				xlog("L_ERR", "call $ci: cannot hold the call for a window of $avp(callee)\n");
				route(unreachable);
			}
		}
		return(-1);
	}
	t_wait_no_more_branches();
	return(1);
}

# Windows that could not be reached (route[relay_call]) leave their failed branches in the transaction. tm answers a
# CANCEL of a held call with 487 at once only when the phony branch is the only one of the current set; with them, it
# would wait out the delay (408, the missed call and the caller's end of the call that late). A relay from the request
# route starts a new set of branches even when it adds none: one to a transport OpenSIPS does not listen on fails
# before it adds a branch, nothing is sent, and the set starts past the failed ones.
route[past_dead_branches] {
	# Only the Request-URI: the windows a failed relay leaves as branches of the message would be tried again.
	while ($msg.branch.last_idx > 0)
		remove_msg_branch(0);
	# No socket forced either (a ring group's window had its WebSocket's): the transport is the destination's.
	$socket_out = NULL;
	$du = "sip:127.0.0.1:9;transport=sctp";
	t_relay();
	resetdsturi();
}

# A window of a held callee registered (event_routing's notification route: no context of the call but its
# transaction): it rings in that transaction, built from the request the transaction keeps (Record-Route, the media
# offer, the caller's name), with the call's reply and failure routes; the call then no longer waits for the phony
# branch, it ends as this ringing does (another window registering meanwhile rings too: branch_route[tried]). A call
# already over (-2), or a window that rings in it already (-3, a renewal of its registration: branch_route[tried]
# drops that branch, and tm logs "failure to add branches"): nothing.
route[woken] {
	if (!t_inject_branches("event"))
		xlog("L_NOTICE", "a window of $avp(aor) registered, not rung in its held call ($rc: over, or ringing already)\n");
}

# A ring group whose members without a window can be woken ($avp(gw_ext), the first $avp(g_woken) of them in their
# order): after the windows of the others are relayed (none at all: the caller hears it ringing, a 180 of ours), the
# transaction waits PUSH_WAIT_SEC for a window of each of them (t_wait_for_new_branches, no limit: once every one of
# them had a window answer, onreply_route[rtp] stops the wait and the call ends as the ringing does), each is woken
# (E_TWAKEPHONE_WAKE names the member and the group) and the windows each registers ring with the others
# (route[group_woken]). Counted per member, not per window: a member who opens two windows takes no colleague's
# place, and counts once among those who must decline for the group to be declined (failure_route).
route[group_hold] {
	$var(wait) = ${PUSH_WAIT_SEC};
	$T_fr_inv_timeout = $var(wait);
	$var(ok) = 0;
	if (t_wait_for_new_branches())
		$var(ok) = 1;
	# The windows woken ring as long as any member's (tm's default).
	$T_fr_inv_timeout = NULL;
	if ($var(ok) == 0) {
		xlog("L_ERR", "call $ci: group $avp(group) cannot wait for its members to wake\n");
		$(avp(g_woken)[*]) = NULL;
		if ($avp(g_windows) == 0)
			route(unreachable);
		return(-1);
	}
	$avp(held) = 1;
	$var(n) = 0;
	while ($(avp(gw_ext)[$var(n)]) != NULL)
		$var(n) = $var(n) + 1;
	# The stack holds them last first: from its end, the first $avp(g_woken). Who they are: $avp(g_wake_list)
	# (",104,105,"), and who of them had a window answer: $avp(g_joined) (onreply_route[rtp]).
	$(avp(g_wake_list)[*]) = NULL;
	$(avp(g_joined)[*]) = NULL;
	$(avp(g_njoined)[*]) = NULL;
	# Those of them a window of rings already, and how many still have none: branch_route[tried] keeps one place
	# for each of these.
	$(avp(g_injected)[*]) = NULL;
	$(avp(g_awaited)[*]) = NULL;
	$var(list) = ",";
	$var(j) = $var(n) - 1;
	$var(left) = $avp(g_woken);
	while ($var(j) >= 0 && $var(left) > 0) {
		$var(member) = $(avp(gw_ext)[$var(j)]);
		$var(list) = $var(list) + $var(member) + ",";
		$(avp(wake_filter)[*]) = NULL;
		$avp(wake_filter) = "aor=" + $var(member);
		# A window that registers, or one that comes back with its Contact (route[hold]).
		$var(followed) = 0;
		if (notify_on_event("E_UL_CONTACT_INSERT", $avp(wake_filter), "group_woken", $var(wait)))
			$var(followed) = $var(followed) + 1;
		if (notify_on_event("E_UL_CONTACT_UPDATE", $avp(wake_filter), "group_woken", $var(wait)))
			$var(followed) = $var(followed) + 1;
		if ($var(followed) < 2)
			xlog("L_ERR", "call $ci: a window of $var(member) may not ring in group $avp(group) (notify_on_event failed)\n");
		$avp(ev_callee) = $var(member);
		route(event_attrs);
		$avp(ev_attr) = "wait";
		$avp(ev_val) = $var(wait);
		raise_event("E_TWAKEPHONE_WAKE", $avp(ev_attr), $avp(ev_val));
		$var(j) = $var(j) - 1;
		$var(left) = $var(left) - 1;
	}
	$avp(g_wake_list) = $var(list);
	$avp(g_njoined) = 0;
	$avp(g_injected) = ",";
	$avp(g_awaited) = $avp(g_woken);
	$var(windows) = $avp(g_windows) + $avp(g_woken);
	$(avp(g_windows)[*]) = NULL;
	$avp(g_windows) = $var(windows);
	if ($var(windows) == $avp(g_woken)) {
		t_reply(180, "Ringing");
		exit;
	}
}

# A ring group none of whose windows could be reached (route[relay_call] 4: they are on dead WebSockets): its members
# whose browser can be woken are, those who had a window ($avp(gd_ext)) after those who had none ($avp(gw_ext)), as
# many as the transaction has room for besides the failed branches and the phony one. None fits: as before, the
# relay's failure.
route[group_dead] {
	$var(n) = 0;
	while ($(avp(gw_ext)[$var(n)]) != NULL)
		$var(n) = $var(n) + 1;
	$var(nd) = 0;
	while ($(avp(gd_ext)[$var(nd)]) != NULL)
		$var(nd) = $var(nd) + 1;
	# Room: 12 branches, the failed ones ($avp(g_windows), all placed) and the phony one taken.
	$var(room) = 11 - $avp(g_windows);
	# In order (the stacks hold them last first): those without a window, then those with dead ones.
	$(avp(gx_ext)[*]) = NULL;
	$var(taken) = 0;
	$var(j) = $var(n) - 1;
	while ($var(j) >= 0 && $var(taken) < $var(room)) {
		$avp(gx_ext) = $(avp(gw_ext)[$var(j)]);
		$var(taken) = $var(taken) + 1;
		$var(j) = $var(j) - 1;
	}
	$var(j) = $var(nd) - 1;
	while ($var(j) >= 0 && $var(taken) < $var(room)) {
		$avp(gx_ext) = $(avp(gd_ext)[$var(j)]);
		$var(taken) = $var(taken) + 1;
		$var(j) = $var(j) - 1;
	}
	if ($var(taken) == 0) {
		$var(relay_rc) = -6;
		route(relay_failed);
	}
	$var(all) = $var(n) + $var(nd);
	if ($var(taken) < $var(all))
		xlog("L_WARN", "call $ci: group $avp(group): $var(n) + $var(nd) members to wake, room for $var(taken)\n");
	# gw_ext as group_hold reads it: the stack of the members to wake, the first of them at its end.
	$(avp(gw_ext)[*]) = NULL;
	$var(j) = $var(taken) - 1;
	while ($var(j) >= 0) {
		$avp(gw_ext) = $(avp(gx_ext)[$var(j)]);
		$var(j) = $var(j) - 1;
	}
	$(avp(gx_ext)[*]) = NULL;
	$(avp(g_woken)[*]) = NULL;
	$avp(g_woken) = $var(taken);
	# None of the windows rings: the group waits for the members it wakes only.
	$(avp(g_windows)[*]) = NULL;
	$avp(g_windows) = 0;
	route(past_dead_branches);
	xlog("L_NOTICE", "call $ci: no window of group $avp(group) can be reached, $var(taken) members woken\n");
	route(group_hold);
	exit;
}

# A window of a member of a held ring group registered: it rings in the group's transaction, tagged with the member
# (onreply_route[rtp] finds the member's name in the group's list). Not when it rings there already, nor when it is a
# second window of its member that would take the place of a member still awaited (branch_route[tried]).
route[group_woken] {
	$(msg.branch.attr(gext)[0]) = $avp(aor);
	if (!t_inject_branches("event"))
		xlog("L_NOTICE", "a window of $avp(aor) registered, not rung in the group call it was woken for ($rc: over, ringing already, or no place)\n");
}

# Every branch of a call, as tm creates it (t_on_branch in route[ring_now]: the relays, and the windows that register
# while it waits). A destination tried already in this call is not tried again: a window that renews its
# registration while it rings (E_UL_CONTACT_UPDATE, the same Contact on the same connection) would ring once per
# renewal. The same Contact on another connection (a WebSocket that died and came back) is another destination: the
# first one could not be reached. A woken member of a ring group keeps one place out of the 12 of the transaction
# until a window of theirs rings: a second window of a member is rung only while there are places left for the
# members still awaited. A branch that rings ends the wait of a held callee (route[hold]). drop(): tm adds no
# branch, and logs "failure to add branches".
branch_route[tried] {
	$var(key) = " " + $ru;
	if ($du != NULL)
		$var(key) = $var(key) + "|" + $du;
	$var(key) = $var(key) + " ";
	if ($avp(tried) != NULL && $(avp(tried){s.index,$var(key)}) != NULL) {
		xlog("L_NOTICE", "call $ci: $ru rings already in this call, not again\n");
		drop();
	}
	if ($avp(g_wake_list) != NULL && $tm.branch.attr(gext) != NULL && $tm.branch.attr(gname) == NULL) {
		$var(member) = $tm.branch.attr(gext);
		$var(mark) = "," + $var(member) + ",";
		if ($(avp(g_wake_list){s.index,$var(mark)}) != NULL) {
			if ($(avp(g_injected){s.index,$var(mark)}) == NULL) {
				$var(injected) = $avp(g_injected) + $var(member) + ",";
				$(avp(g_injected)[*]) = NULL;
				$avp(g_injected) = $var(injected);
				$var(awaited) = $avp(g_awaited) - 1;
				$(avp(g_awaited)[*]) = NULL;
				$avp(g_awaited) = $var(awaited);
			} else {
				# The places left once this branch is added (12 branches, 0 to 11).
				$var(left) = 11 - $T_branch_idx;
				if ($var(left) < $avp(g_awaited)) {
					xlog("L_NOTICE", "call $ci: group $avp(group): another window of $var(member), no place left beside the $avp(g_awaited) members awaited\n");
					drop();
				}
			}
		}
	}
	$var(tried) = $var(key);
	if ($avp(tried) != NULL)
		$var(tried) = $avp(tried) + $var(key);
	$(avp(tried)[*]) = NULL;
	$avp(tried) = $var(tried);
	if ($avp(held_one) == 1)
		t_wait_no_more_branches();
}

#### Ring groups (step 4c, ADR 0014) ###################################################################################
# A number of `call_groups` that is no extension (route[rules_next] reads both at once, an extension wins) rings
# the registered windows of its members at once; the first to answer takes the call and tm cancels the others
# (`Reason: SIP;cause=200`, "answered elsewhere" for them). Only as dialled (never reached by a forward: the Gateway
# refuses a forward to a group), without the members' own rules: neither their forwards nor a call that rings them
# moves on, and a member in "do not disturb" (or the caller) is left out. A transaction of this OpenSIPS carries 12
# destinations at most (MAX_BRANCHES of its build, the packaged one): one window of each member first, in their
# order, then their second ones, and so on, as many as fit; a window left out is logged (route[group_ring]). The
# Gateway allows 12 members. Nobody to ring: 480, a missed call for the group. Nobody answers: the refusal (6xx) only
# when every window refused, else 480 (failure_route). The events name the member that rings or answers (`callee`)
# and the group (`group`); acc's CDR names the member who answered, the missed call the group.

# The members of the group $rU, in their order, with their names: asynchronous, as the rules.
route[group_next] {
	$(avp(q4c)[*]) = NULL;
	$(avp(g_ext)[*]) = NULL;
	$(avp(g_name)[*]) = NULL;
	$var(group_caller) = "";
	if ($avp(caller) =~ "^[A-Za-z0-9._+-]{1,64}$")
		$var(group_caller) = $avp(caller);
	route(name_sql);
	# Step 5: whether each member has a browser to wake (`push_targets`), while that table may be named, and not
	# after a read naming it failed ($avp(g_nowake), route[group_loaded]: a `push_targets` the Gateway has not
	# upgraded yet fails the query, the group still rings its members' windows).
	$(avp(g_wake)[*]) = NULL;
	$(avp(q5)[*]) = NULL;
	$var(wake_col) = "0";
	if ($shv(no5_until) <= $Ts && $avp(g_nowake) == NULL) {
		$avp(q5) = 1;
		$var(wake_col) = "CASE WHEN EXISTS (SELECT 1 FROM push_targets p WHERE p.extension = x.ext AND p.alive_until > now()) THEN 1 ELSE 0 END";
	}
	# The media offer before the read: a member's window that a push wakes rings in a branch built from the request
	# the transaction keeps, which the read updates (route[wake_next]).
	if ($avp(rtp_on) == NULL && has_body_part("application/sdp"))
		route(rtp_offer);
	$var(group_query) = "SELECT x.ext, coalesce((SELECT " + $var(name_sql) + " FROM display_names n WHERE n.extension = x.ext), ''), " + $var(wake_col) + " FROM call_groups g CROSS JOIN LATERAL unnest(g.members) WITH ORDINALITY AS x(ext, pos) WHERE g.number = '" + $rU + "' AND x.ext <> '" + $var(group_caller) + "' AND NOT EXISTS (SELECT 1 FROM call_rules r WHERE r.extension = x.ext AND r.dnd AND (r.dnd_until IS NULL OR r.dnd_until > now())) ORDER BY x.pos";
	async(sql_query("$var(group_query)", "$avp(g_ext);$avp(g_name);$avp(g_wake)"), group_loaded);
}

route[group_loaded] {
	# 1: rows; -2: nobody to ring; any other failure (timeout, database down): nobody either, the caller is told.
	$var(group_rc) = $rc;
	if (t_was_cancelled())
		route(cancelled);
	if ($var(group_rc) < 0 && $var(group_rc) != -2 && route(read_failed)) {
		# Made again without whether the members can be woken: the failure may be that column's.
		if ($avp(q5) == 1)
			$avp(g_nowake) = 1;
		route(group_next);
		exit;
	}
	$(avp(q_again)[*]) = NULL;
	$(avp(q5)[*]) = NULL;
	if ($var(group_rc) < 0 && $var(group_rc) != -2)
		xlog("L_WARN", "call $ci: members of group $rU not read ($var(group_rc), twice)\n");
	route(group_ring);
	exit;
}

# The windows of the members, collected first: each member's lookup appends its windows (10 at most) as branches,
# copied into the $avp(w_*) lists, then removed, so that a member with many windows never fills the transaction. Then
# placed one window of each member first, then the second ones and so on, up to 12: the first in the Request-URI,
# the others as branches, each tagged with its member (`gext`) and the member's name (`gname`): onreply_route[rtp]
# knows whose phone rings or answers by them.
route[group_ring] {
	$avp(group) = $rU;
	# No rules of anyone's apply (a row of rules left for this number when it was an extension included).
	$(avp(r_always)[*]) = NULL;
	$(avp(r_busy)[*]) = NULL;
	$(avp(r_noanswer)[*]) = NULL;
	$(avp(r_dnd)[*]) = NULL;
	$(avp(w_uri)[*]) = NULL;
	$(avp(w_duri)[*]) = NULL;
	$(avp(w_path)[*]) = NULL;
	$(avp(w_sock)[*]) = NULL;
	$(avp(w_flags)[*]) = NULL;
	$(avp(w_ext)[*]) = NULL;
	$(avp(w_name)[*]) = NULL;
	$(avp(w_rank)[*]) = NULL;
	$(avp(gw_ext)[*]) = NULL;
	$(avp(gd_ext)[*]) = NULL;
	# The lists are stacks: the window collected last is at index 0.
	$var(windows) = 0;
	# Members with a window, and members without one whose browser can be woken (step 5).
	$var(members_on) = 0;
	$var(to_wake) = 0;
	$var(i) = 0;
	while ($(avp(g_ext)[$var(i)]) != NULL) {
		$var(ext) = $(avp(g_ext)[$var(i)]);
		$var(name) = $(avp(g_name)[$var(i)]);
		$var(wake) = 0;
		if ($(avp(g_wake)[$var(i)]) != NULL)
			$var(wake) = $(avp(g_wake)[$var(i)]);
		$var(i) = $var(i) + 1;
		$var(found) = 0;
		if ($var(ext) =~ "^[A-Za-z0-9._+-]{1,64}$") {
			$var(aor) = "sip:" + $var(ext) + "@" + $avp(domain);
			if (lookup("location", "to-branches-only", "$var(aor)"))
				$var(found) = 1;
		}
		if ($var(found) == 1) {
			# Index 0 of $msg.branch is the Request-URI: the windows are 1 to last_idx.
			$var(b) = 1;
			while ($var(b) <= $msg.branch.last_idx) {
				$avp(w_uri) = $(msg.branch.uri[$var(b)]);
				$var(v) = "";
				if ($(msg.branch.duri[$var(b)]) != NULL)
					$var(v) = $(msg.branch.duri[$var(b)]);
				$avp(w_duri) = $var(v);
				$var(v) = "";
				if ($(msg.branch.path[$var(b)]) != NULL)
					$var(v) = $(msg.branch.path[$var(b)]);
				$avp(w_path) = $var(v);
				$var(v) = "";
				if ($(msg.branch.socket[$var(b)]) != NULL)
					$var(v) = $(msg.branch.socket[$var(b)]);
				$avp(w_sock) = $var(v);
				$var(v) = "";
				if ($(msg.branch.flags[$var(b)]) != NULL)
					$var(v) = $(msg.branch.flags[$var(b)]);
				$avp(w_flags) = $var(v);
				$avp(w_ext) = $var(ext);
				$avp(w_name) = $var(name);
				$avp(w_rank) = $var(b) - 1;
				$var(windows) = $var(windows) + 1;
				$var(b) = $var(b) + 1;
			}
			# remove_msg_branch() counts the appended branches from 0, without the Request-URI.
			while ($msg.branch.last_idx > 0)
				remove_msg_branch(0);
			$var(members_on) = $var(members_on) + 1;
			# Its browser can be woken too, should none of the group's windows be reachable (route[group_dead]).
			if ($var(wake) == 1)
				$avp(gd_ext) = $var(ext);
		} else if ($var(wake) == 1 && $var(ext) =~ "^[A-Za-z0-9._+-]{1,64}$") {
			$avp(gw_ext) = $var(ext);
			$var(to_wake) = $var(to_wake) + 1;
		}
	}
	# Room for the members to wake: one destination each, and the branch that keeps the call waiting for them, out
	# of 12; every member with a window keeps one first. Those that do not fit are not woken (logged).
	$var(woken) = $var(to_wake);
	$var(room) = 11 - $var(members_on);
	if ($var(woken) > $var(room))
		$var(woken) = $var(room);
	if ($var(woken) < $var(to_wake))
		xlog("L_WARN", "call $ci: group $avp(group): $var(to_wake) members to wake, room for $var(woken)\n");
	$var(cap) = 12;
	if ($var(woken) > 0)
		$var(cap) = 11 - $var(woken);
	$avp(g_woken) = $var(woken);
	if ($var(windows) == 0 && $var(woken) > 0) {
		# Nobody has a window: the call waits for the members a push wakes (route[group_hold]).
		$ru = "sip:" + $avp(group) + "@" + $avp(domain);
		$avp(g_windows) = 0;
		route(ring);
		exit;
	}
	if ($var(windows) == 0) {
		xlog("L_NOTICE", "call $ci: nobody of group $avp(group) to ring\n");
		$ru = "sip:" + $avp(group) + "@" + $avp(domain);
		if ($avp(rtp_on) != NULL)
			rtpengine_delete();
		route(account_missed);
		route(calling);
		t_reply(480, "Temporarily Unavailable");
		exit;
	}
	# Rank by rank (a member's first window, then its second...), members in their order: the oldest collected first.
	$var(placed) = 0;
	$var(left) = 0;
	$var(first) = -1;
	$var(rank) = 0;
	$var(done) = 0;
	while ($var(done) < $var(windows) && $var(rank) < 10) {
		$var(j) = $var(windows) - 1;
		while ($var(j) >= 0) {
			if ($(avp(w_rank)[$var(j)]) == $var(rank)) {
				if ($var(placed) >= $var(cap)) {
					$var(left) = $var(left) + 1;
				} else if ($var(first) < 0) {
					# The Request-URI, set last: append_msg_branch() would copy its destination into the branches.
					$var(first) = $var(j);
					$var(placed) = $var(placed) + 1;
				} else if (append_msg_branch($(avp(w_uri)[$var(j)]))) {
					$var(k) = $msg.branch.last_idx;
					$var(w) = $var(j);
					route(group_window);
					$var(placed) = $var(placed) + 1;
				} else {
					$var(left) = $var(left) + 1;
				}
			}
			$var(j) = $var(j) - 1;
		}
		$var(rank) = $var(rank) + 1;
		$var(done) = $var(placed) + $var(left);
	}
	$ru = $(avp(w_uri)[$var(first)]);
	resetdsturi();
	$var(k) = 0;
	$var(w) = $var(first);
	route(group_window);
	$avp(g_windows) = $var(placed);
	if ($var(left) > 0)
		xlog("L_WARN", "call $ci: group $avp(group): $var(left) of its $var(windows) windows left out, a call rings 12 at most\n");
	route(ring);
}

# Window $var(w) of the lists onto branch $var(k) (0: the Request-URI): where to send it, and whose it is.
route[group_window] {
	if ($(avp(w_duri)[$var(w)]) != "")
		$(msg.branch.duri[$var(k)]) = $(avp(w_duri)[$var(w)]);
	if ($(avp(w_path)[$var(w)]) != "")
		$(msg.branch.path[$var(k)]) = $(avp(w_path)[$var(w)]);
	if ($(avp(w_sock)[$var(w)]) != "")
		$(msg.branch.socket[$var(k)]) = $(avp(w_sock)[$var(w)]);
	if ($(avp(w_flags)[$var(w)]) != "")
		$(msg.branch.flags[$var(k)]) = $(avp(w_flags)[$var(w)]);
	$(msg.branch.attr(gext)[$var(k)]) = $(avp(w_ext)[$var(w)]);
	$(msg.branch.attr(gname)[$var(k)]) = $(avp(w_name)[$var(w)]);
}

# The extension the call named in Replaces reached, from the dialog of that call ($var(replaces_to); empty when this
# proxy does not know the call: the INVITE then goes to the extension it names, as dialled). Only when the INVITE
# names the extension that call dialled: the extension it reached is not anyone's to ring by naming a Call-ID.
route[replaces_target] {
	$var(replaced) = $(hdr(Replaces){s.select,0,;});
	if ($var(replaced) == NULL || $var(replaced) == "")
		return(-1);
	if (!load_dialog_ctx($var(replaced), "callid"))
		return(-1);
	$var(reached) = $dlg_val(callee);
	$var(was_dialled) = $dlg_val(dialled);
	if ($dlg_val(trunk) != NULL)
		$var(replaces_trunk) = 1;
	unload_dialog_ctx();
	if ($var(was_dialled) == NULL || $var(was_dialled) != $rU)
		return(-1);
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
# The rules of the extension now called ($rU) come from `call_rules`, one query on its primary key, asynchronous
# (route[rules_next]: the process serves other messages while PostgreSQL answers). After a failure (failure_route,
# route[relay_call]), from the rules read before the ringing (route[ring], route[rules_local]): no query there, where
# async is not available and a synchronous one would hold tm's timer process. Every read is bounded by the
# statement_timeout of OPENSIPS_RULES_DB_URL (entrypoint.sh). None when the extension has no row, when the query
# fails or times out (the call goes on, unforwarded) or for a user part that cannot be one of ours. The "do not
# disturb" holds while its end is ahead on the database's clock: it lifts at its date by itself. A caller may
# cancel during any read: each resume checks it first (route[cancelled]).

# The query for $rU: only the characters a `subscriber` user name has get there, nothing that could close its quote.
# The extension's name in the directory comes with its rules ($avp(r_name): what the caller is shown if it answers).
# One row always (no rules: NULL columns, no AVP).
route[rules_query] {
	$(avp(r_always)[*]) = NULL;
	$(avp(r_busy)[*]) = NULL;
	$(avp(r_noanswer)[*]) = NULL;
	$(avp(r_delay)[*]) = NULL;
	$(avp(r_dnd)[*]) = NULL;
	$(avp(r_message)[*]) = NULL;
	$(avp(r_retry)[*]) = NULL;
	$(avp(r_name)[*]) = NULL;
	$(avp(r_group)[*]) = NULL;
	if (!($rU =~ "^[A-Za-z0-9._+-]{1,64}$"))
		return(-1);
	route(name_sql);
	# The name of $rU, and, for the first read (route[rules_next]), the caller's and the group flag: only while the
	# tables of step 4c may be named (route[tables_4c]); NULL otherwise, and the rules are read all the same.
	$(avp(q4c)[*]) = NULL;
	$var(name_col) = "NULL";
	if (route(tables_4c)) {
		$avp(q4c) = 1;
		$var(name_col) = "(SELECT " + $var(name_sql) + " FROM display_names n WHERE n.extension = '" + $rU + "')";
	}
	$var(rules_cols) = "r.forward_always, r.forward_busy, r.forward_noanswer, r.noanswer_delay, CASE WHEN r.dnd AND (r.dnd_until IS NULL OR r.dnd_until > now()) THEN 1 ELSE 0 END, regexp_replace(r.dnd_message, '[[:cntrl:]]', '', 'g'), CASE WHEN r.dnd AND r.dnd_until > now() THEN ceil(extract(epoch FROM r.dnd_until - now()))::integer END, " + $var(name_col);
	$var(rules_from) = " FROM (SELECT 1) AS one LEFT JOIN call_rules r ON r.extension = '" + $rU + "'";
	$var(rules_query) = "SELECT " + $var(rules_cols) + $var(rules_from);
	return(1);
}

# Request route: reads the rules of $rU without blocking, then route[rules_step] (from route[rules_loaded], where it resumes).
# The first read, of the extension dialled, also tells the caller's name and whether $rU is a ring group (a number of
# `call_groups` no account has: an extension wins).
route[rules_next] {
	if (!route(rules_query)) {
		route(rules_step);
		exit;
	}
	if ($avp(d_loaded) == NULL) {
		$var(first_caller) = "";
		if ($avp(caller) =~ "^[A-Za-z0-9._+-]{1,64}$")
			$var(first_caller) = $avp(caller);
		$var(first_cols) = ", NULL, 0";
		if ($avp(q4c) == 1)
			$var(first_cols) = ", (SELECT " + $var(name_sql) + " FROM display_names n WHERE n.extension = '" + $var(first_caller) + "'), CASE WHEN EXISTS (SELECT 1 FROM call_groups g WHERE g.number = '" + $rU + "') AND NOT EXISTS (SELECT 1 FROM subscriber s WHERE s.username = '" + $rU + "') THEN 1 ELSE 0 END";
		$var(rules_query) = "SELECT " + $var(rules_cols) + $var(first_cols) + $var(rules_from);
		async(sql_query_one("$var(rules_query)", "$avp(r_always);$avp(r_busy);$avp(r_noanswer);$avp(r_delay);$avp(r_dnd);$avp(r_message);$avp(r_retry);$avp(r_name);$avp(n_caller);$avp(r_group)"), rules_loaded);
		exit;
	}
	async(sql_query_one("$var(rules_query)", "$avp(r_always);$avp(r_busy);$avp(r_noanswer);$avp(r_delay);$avp(r_dnd);$avp(r_message);$avp(r_retry);$avp(r_name)"), rules_loaded);
}

route[rules_loaded] {
	# 1: a row; a failure is read again once (route[read_failed]); twice (timeout, database down): no rules, the call
	# goes on (and no names: the phone's own From). The number dialled may then be a ring group nobody can tell:
	# nobody registered there is told as unreachable (480), not as a number that does not exist (route[unreachable]).
	$var(rules_rc) = $rc;
	if (t_was_cancelled())
		route(cancelled);
	if ($var(rules_rc) < 0 && $var(rules_rc) != -2 && route(read_failed)) {
		route(rules_next);
		exit;
	}
	$(avp(q_again)[*]) = NULL;
	if ($var(rules_rc) < 0 && $var(rules_rc) != -2) {
		xlog("L_WARN", "call $ci: rules of $rU not read ($var(rules_rc), twice), the call goes on without them\n");
		if ($avp(d_loaded) == NULL && $avp(fwd_hops) == 0)
			$avp(dialled_unread) = 1;
	}
	if ($var(rules_rc) == 1 && $avp(q4c) == 1 && $avp(d_loaded) == NULL)
		$avp(names_read) = 1;
	# The first read done: the caller's name goes into the From, whatever comes next.
	route(caller_name);
	route(rules_step);
}

# What the rules just read say, in the request route: another extension (its rules are read in turn), the windows
# to ring, a refusal (route[dnd_refuse], which ends the script) or nobody to ring.
route[rules_step] {
	# A ring group, as dialled: its members ring, without anyone's rules.
	if ($avp(fwd_hops) == 0 && $avp(d_loaded) == NULL && $avp(r_group) == 1) {
		$avp(d_loaded) = 1;
		route(group_next);
		exit;
	}
	# Nothing rang yet: a refusal leaves nobody behind (E_TWAKEPHONE_DND's `code`).
	$var(dnd_code) = 0;
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
	# In the request route, where the transaction may be held for a browser to wake (route[wake_next]).
	$var(may_wake) = 1;
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
	if ($var(decided) == 3) {
		route(wake_next);
		exit;
	}
	route(unreachable);
	exit;
}

# The rules of the extension reached, loaded in $avp(r_*): 1 the call moved to another extension (load its rules
# next), 2 its windows are found (ring them), 3 nobody registered but a browser of theirs may be woken (in the
# request route only, $var(may_wake), once per extension: route[wake_next] reads whether it can), -1 nobody to ring.
# A refusal ends the script (route[dnd_refuse]). Before ringing: the immediate forward; during a "do not disturb",
# the no-answer forward, else the busy one, else a refusal. Nobody registered: a browser to wake (step 5), else the
# no-answer forward, at once (nobody can answer).
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
	if ($var(may_wake) == 1 && $avp(held) == NULL && ($avp(wake_checked) == NULL || $avp(wake_checked) != $avp(callee)))
		return(3);
	if ($avp(r_noanswer) != NULL && route(forward_to, $avp(r_noanswer)))
		return(1);
	return(-1);
}

# Before ringing $avp(callee): the rules and the name of every extension its busy and no-answer forwards can lead to,
# three forwards deep (each forward of those, in turn), in one query: one row per extension, in the $avp(p_*) lists,
# a value for each column of each row (no NULL: the lists stay aligned). The callee's own rules are already read.
route[preload_query] {
	$(avp(p_ext)[*]) = NULL;
	$(avp(p_always)[*]) = NULL;
	$(avp(p_busy)[*]) = NULL;
	$(avp(p_noanswer)[*]) = NULL;
	$(avp(p_delay)[*]) = NULL;
	$(avp(p_dnd)[*]) = NULL;
	$(avp(p_message)[*]) = NULL;
	$(avp(p_retry)[*]) = NULL;
	$(avp(p_name)[*]) = NULL;
	if (!($avp(callee) =~ "^[A-Za-z0-9._+-]{1,64}$"))
		return(-1);
	route(name_sql);
	$(avp(q4c)[*]) = NULL;
	$var(name_col) = "''";
	if (route(tables_4c)) {
		$avp(q4c) = 1;
		$var(name_col) = "coalesce((SELECT " + $var(name_sql) + " FROM display_names n WHERE n.extension = x.extension), '')";
	}
	$var(preload_query) = "WITH RECURSIVE reach(extension, depth) AS (SELECT f.target, 1 FROM call_rules c, unnest(ARRAY[c.forward_busy, c.forward_noanswer]) AS f(target) WHERE c.extension = '" + $avp(callee) + "' AND f.target IS NOT NULL UNION SELECT f.target, r.depth + 1 FROM reach r JOIN call_rules c ON c.extension = r.extension, unnest(ARRAY[c.forward_always, c.forward_busy, c.forward_noanswer]) AS f(target) WHERE f.target IS NOT NULL AND r.depth < 3) SELECT x.extension, coalesce(r.forward_always, ''), coalesce(r.forward_busy, ''), coalesce(r.forward_noanswer, ''), coalesce(r.noanswer_delay, 0), CASE WHEN r.dnd AND (r.dnd_until IS NULL OR r.dnd_until > now()) THEN 1 ELSE 0 END, coalesce(regexp_replace(r.dnd_message, '[[:cntrl:]]', '', 'g'), ''), coalesce(CASE WHEN r.dnd AND r.dnd_until > now() THEN ceil(extract(epoch FROM r.dnd_until - now()))::integer END, 0), " + $var(name_col) + " FROM (SELECT DISTINCT extension FROM reach) AS x LEFT JOIN call_rules r ON r.extension = x.extension";
	return(1);
}

# After a failure: route[rules_decide] on the rules read before the ringing, until there are windows to ring (2) or
# nobody (-1). An extension the preload did not return has no rules (no row, or the preload failed).
route[rules_local] {
	$var(local_hops) = 0;
	# After a failure: no browser is woken any more (no transaction to hold from here).
	$var(may_wake) = 0;
	while ($var(local_hops) < 4) {
		$var(local_hops) = $var(local_hops) + 1;
		if (route(rules_query))
			route(rules_preloaded);
		route(rules_decide);
		$var(decided) = $rc;
		if ($var(decided) != 1)
			return($var(decided));
	}
	return(-1);
}

# The preloaded rules of $rU into $avp(r_*), as route[rules_next] reads them.
route[rules_preloaded] {
	$var(i) = 0;
	while ($(avp(p_ext)[$var(i)]) != NULL) {
		if ($(avp(p_ext)[$var(i)]) == $rU) {
			if ($(avp(p_always)[$var(i)]) != "")
				$avp(r_always) = $(avp(p_always)[$var(i)]);
			if ($(avp(p_busy)[$var(i)]) != "")
				$avp(r_busy) = $(avp(p_busy)[$var(i)]);
			if ($(avp(p_noanswer)[$var(i)]) != "")
				$avp(r_noanswer) = $(avp(p_noanswer)[$var(i)]);
			$avp(r_delay) = $(avp(p_delay)[$var(i)]);
			$avp(r_dnd) = $(avp(p_dnd)[$var(i)]);
			if ($(avp(p_message)[$var(i)]) != "")
				$avp(r_message) = $(avp(p_message)[$var(i)]);
			if ($(avp(p_retry)[$var(i)]) > 0)
				$avp(r_retry) = $(avp(p_retry)[$var(i)]);
			if ($(avp(p_name)[$var(i)]) != "")
				$avp(r_name) = $(avp(p_name)[$var(i)]);
			return(1);
		}
		$var(i) = $var(i) + 1;
	}
	return(-1);
}

# Nobody to ring at the end of the request route. The dialled extension does not want to be disturbed (its
# forward led nowhere): its refusal, with its message. Else 404 for an extension nobody registered, and 480 for a
# call forwarded to one (the extension dialled exists: it cannot be reached now), or for a number whose rules could
# not be read (it may be a ring group: never told it does not exist because the database failed).
route[unreachable] {
	if ($avp(d_dnd) == 1)
		route(dnd_refuse_dialled);
	# The offer made before looking for a browser to wake (route[wake_next]) is over.
	if ($avp(rtp_on) != NULL)
		rtpengine_delete();
	route(account_missed);
	route(calling);
	if ($avp(fwd_hops) == 0 && $avp(dialled_unread) != 1)
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
# is set) and the missed call waits for failure_route; so it does when the call was forwarded from a "do not
# disturb" (a failure here is answered with it, a missed call for the extension dialled). Otherwise the missed call
# is accounted now.
route[arm_failure] {
	if ($avp(fwd_hops) < 3 && ($avp(r_busy) != NULL || $avp(r_noanswer) != NULL)) {
		if ($avp(r_noanswer) != NULL)
			$T_fr_inv_timeout = $avp(r_delay);
		else
			$T_fr_inv_timeout = NULL;
	} else {
		$T_fr_inv_timeout = NULL;
		# A ring group's missed call is written by failure_route, with what the caller is told (route[group_missed]).
		if ($avp(d_dnd) != 1 && $avp(group) == NULL)
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

# The missed call of a ring group, as the caller is told it ($param(1): code and reason): acc's own report would carry
# the reply tm picked among the windows (a member's decline), not the 480 the script answers instead.
route[group_missed] {
	if ($avp(missed_on) != NULL)
		return(1);
	$avp(missed_on) = 1;
	acc_db_request("$param(1)", "missed_calls");
	acc_evi_request("$param(1)");
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
	# Never to the operator (a call from the public network): neither the message nor the state leave the platform.
	if ($dlg_val(trunk) == "caller")
		$var(dnd_told) = 0;
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
	# The status of the extension that rang before (declined, busy, no answer), 0 when none did.
	$avp(ev_attr) = "code";
	$avp(ev_val) = $var(dnd_code);
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

# In-dialog requests. A contact that cannot be reached: 477 "Send failed" (tm answers it itself when it creates the
# transaction here, the script otherwise); the 500 is for a relay that fails otherwise before any reply.
route[relay] {
	if (!t_relay()) {
		if ($rc == -6)
			t_reply(477, "Send failed");
		else
			send_reply(500, "Internal Error");
	}
}

# The initial INVITE to the windows of $avp(callee), from the request route or failure_route (the transaction exists:
# tm leaves the reply of a failed relay to us). None of them can be reached (windows gone without unregistering, their
# WebSocket dead): nobody can answer, a no answer at once, so the no-answer forward is taken; failing that, the dialled
# extension's "do not disturb" if the call was forwarded from it, else 477 "Send failed", that the softphone renders
# as "unreachable" (proven by the e2e). The 500 is for a relay that fails otherwise. Either way, a missed call.
route[relay_call] {
	# Where this relay sends (the destinations of the windows found): a window that registers before the call
	# follows the registrations is told from them (route[registered_meanwhile]).
	$(avp(seen_dst)[*]) = NULL;
	if ($var(relay_request) == 1 && $avp(group) == NULL) {
		$var(seen) = " ";
		$var(b) = 0;
		while ($var(b) <= $msg.branch.last_idx) {
			$var(dst) = $(msg.branch.uri[$var(b)]);
			if ($(msg.branch.duri[$var(b)]) != NULL)
				$var(dst) = $(msg.branch.duri[$var(b)]);
			$var(seen) = $var(seen) + $var(dst) + " ";
			$var(b) = $var(b) + 1;
		}
		$avp(seen_dst) = $var(seen);
	}
	# $rc is t_relay's within the if only.
	$var(relay_rc) = 1;
	if (!t_relay())
		$var(relay_rc) = $rc;
	if ($var(relay_rc) > 0)
		return(1);
	xlog("L_NOTICE", "call $ci: relay to $avp(callee) failed ($var(relay_rc))\n");
	# Windows left registered on dead WebSockets (a laptop put to sleep): from the request route, the browser may be
	# woken like that of someone without a window (route[wake_next]; tm freed the branches it could not send, the
	# transaction can still wait for a new one): 3, and route[ring_now] reads whether. Nobody to wake: on with
	# route[relay_failed] there.
	# Never for an INVITE with Replaces: a window that opens could not carry the dialog it replaces.
	if ($var(relay_rc) == -6 && $var(relay_request) == 1 && $avp(group) == NULL && $avp(held) == NULL && !is_present_hf("Replaces") && ($avp(wake_checked) == NULL || $avp(wake_checked) != $avp(callee))) {
		$avp(relay_dead) = 1;
		return(3);
	}
	# A ring group none of whose windows can be reached: its members whose browser can be woken are (4,
	# route[group_dead]), with those who had no window.
	if ($var(relay_rc) == -6 && $var(relay_request) == 1 && $avp(group) != NULL && $avp(held) == NULL && ($avp(gd_ext) != NULL || $avp(g_woken) > 0))
		return(4);
	route(relay_failed);
}

# The relay failed ($var(relay_rc)): the no-answer forward when no window could be reached, else the failure.
route[relay_failed] {
	# A forward's relay is not held for a browser to wake (route[relay_call]).
	$var(relay_request) = 0;
	if ($var(relay_rc) == -6)
		$var(dnd_code) = 477;
	else
		$var(dnd_code) = 500;
	if ($var(relay_rc) == -6 && $avp(r_noanswer) != NULL) {
		$var(relay_from) = $avp(callee);
		if (route(forward_to, $avp(r_noanswer))) {
			$(avp(ringing)[*]) = NULL;
			$(avp(ring_at)[*]) = NULL;
			route(rules_local);
			if ($rc == 2) {
				$dlg_val(callee) = $avp(callee);
				route(forwarded, $var(relay_from), "477");
				t_on_reply("rtp");
				t_on_failure("call_failed");
				route(arm_failure);
				route(relay_call);
				exit;
			}
			$(avp(callee)[*]) = NULL;
			$avp(callee) = $var(relay_from);
			$acc_extra(callee) = $var(relay_from);
		}
	}
	if ($avp(d_dnd) == 1 && $avp(callee) != $avp(dialled))
		route(dnd_refuse_dialled);
	if ($avp(rtp_on) != NULL)
		rtpengine_delete();
	route(account_missed);
	if ($var(relay_rc) == -6)
		t_reply(477, "Send failed");
	else
		t_reply(500, "Internal Error");
	exit;
}

# Every reply relayed: no identity a phone asserts passes on (onreply_route[rtp] asserts who answered, after this),
# nor a refusal that only this script tells (Twake-Call-Refused: a phone or the operator would have the app show it).
onreply_route {
	remove_hf("P-Asserted-Identity");
	remove_hf("P-Preferred-Identity");
	remove_hf("Remote-Party-ID");
	remove_hf("Twake-Call-Refused");
}

onreply_route[rtp] {
	# Only this script tells a "do not disturb" (route[dnd_reply]) and who answered (below): an UA's own Twake-Dnd or
	# P-Asserted-Identity headers do not pass, or the caller would show them as the dialled extension's.
	remove_hf_glob("Twake-Dnd*");
	remove_hf("Twake-Call-Refused");
	remove_hf("P-Asserted-Identity");
	# The callee's Contact: same ".invalid" host, same fix (see above).
	fix_nated_contact();
	# An offer in the 2xx of an INVITE without SDP (route[late_offer]); else the answer to the offer of the request.
	if (has_body_part("application/sdp")) {
		if ($avp(late_offer) != NULL) {
			if ($rs >= 200 && $rs < 300)
				route(rtp_late_offer);
		} else {
			route(rtp_answer);
		}
	}
	# The person is being called (180, 183 or another provisional answer past 100 Trying, which only says the server
	# got the INVITE): failure_route[trunk_failed] tries no other server.
	if ($rs > 100 && $rs < 200 && $dlg_val(trunk) == "callee")
		$avp(t_rang) = 1;
	# Ringing and answer are not accounted: told to the Gateway as events of our own, once per call (once per member
	# for the ringing of a ring group). Only the initial INVITE carries $avp(callee): the 200 of a re-INVITE (hold,
	# resume) raises nothing.
	if ($avp(callee) != NULL) {
		# A window declining (6xx) declines the call, its other windows stop ringing (tm's 6xx block, off for the
		# ring groups: one member declining leaves the colleagues' phones ringing).
		if ($rs >= 600 && $avp(group) == NULL)
			t_cancel_branch("o");
		# A ring group: the member whose window this is (route[group_ring]); a window a push woke has no name of
		# its own (route[group_woken]): the member's in the group's list.
		$var(member) = "";
		$var(member_name) = "";
		$var(woken_window) = 0;
		if ($avp(group) != NULL && $tm.branch.attr(gext) != NULL) {
			$var(member) = $tm.branch.attr(gext);
			if ($tm.branch.attr(gname) != NULL) {
				$var(member_name) = $tm.branch.attr(gname);
			} else {
				$var(woken_window) = 1;
				$var(k) = 0;
				while ($(avp(g_ext)[$var(k)]) != NULL) {
					if ($(avp(g_ext)[$var(k)]) == $var(member) && $var(member_name) == "")
						$var(member_name) = $(avp(g_name)[$var(k)]);
					$var(k) = $var(k) + 1;
				}
			}
		}
		# A member woken for the group whose window answers (rings, declines...) had its window: once every one of
		# them had theirs, the call no longer waits (route[group_hold]).
		if ($var(woken_window) == 1 && $avp(g_wake_list) != NULL) {
			$var(mark) = "," + $var(member) + ",";
			if ($(avp(g_wake_list){s.index,$var(mark)}) != NULL && ($avp(g_joined) == NULL || $(avp(g_joined){s.index,$var(mark)}) == NULL)) {
				$var(joined) = ",";
				if ($avp(g_joined) != NULL)
					$var(joined) = $avp(g_joined);
				$(avp(g_joined)[*]) = NULL;
				$avp(g_joined) = $var(joined) + $var(member) + ",";
				$var(nj) = $avp(g_njoined) + 1;
				$(avp(g_njoined)[*]) = NULL;
				$avp(g_njoined) = $var(nj);
				if ($var(nj) >= $avp(g_woken))
					t_wait_no_more_branches();
			}
		}
		# A ring group: the windows that declined, once each, a woken member's once whatever its windows
		# (failure_route tells the caller "declined" only when they all did).
		if ($rs >= 600 && $avp(group) != NULL) {
			$var(mark) = ",b" + $T_branch_idx + ",";
			if ($var(woken_window) == 1)
				$var(mark) = ",m" + $var(member) + ",";
			if ($avp(g_declined) == NULL || $(avp(g_declined){s.index,$var(mark)}) == NULL) {
				$var(declined) = ",";
				if ($avp(g_declined) != NULL)
					$var(declined) = $avp(g_declined);
				$(avp(g_declined)[*]) = NULL;
				$avp(g_declined) = $var(declined) + $(var(mark){s.substr,1,0});
				$var(declines) = 0;
				if ($avp(g_declines) != NULL)
					$var(declines) = $avp(g_declines);
				$(avp(g_declines)[*]) = NULL;
				$avp(g_declines) = $var(declines) + 1;
			}
		}
		if (($rs == 180 || $rs == 183) && $var(member) != "") {
			$var(mark) = "," + $var(member) + ",";
			if ($avp(g_rang) == NULL || $(avp(g_rang){s.index,$var(mark)}) == NULL) {
				$var(rang) = ",";
				if ($avp(g_rang) != NULL)
					$var(rang) = $avp(g_rang);
				$(avp(g_rang)[*]) = NULL;
				$avp(g_rang) = $var(rang) + $var(member) + ",";
				$avp(ev_callee) = $var(member);
				route(event_attrs);
				raise_event("E_TWAKEPHONE_RINGING", $avp(ev_attr), $avp(ev_val));
			}
		} else if (($rs == 180 || $rs == 183) && $avp(group) == NULL && $avp(ringing) == NULL) {
			$avp(ringing) = 1;
			# When the windows of this callee started ringing: failure_route tells a ringing that lasted its delay.
			$(avp(ring_at)[*]) = NULL;
			$avp(ring_at) = $Ts;
			route(event_attrs);
			raise_event("E_TWAKEPHONE_RINGING", $avp(ev_attr), $avp(ev_val));
		} else if ($rs == 200 && $avp(answered) == NULL) {
			$avp(answered) = 1;
			# The member who answered a ring group is the callee from now on: in the CDR, in the dialog (an INVITE
			# with Replaces for this call goes to them), in the events.
			if ($var(member) != "") {
				$(avp(callee)[*]) = NULL;
				$avp(callee) = $var(member);
				$acc_extra(callee) = $var(member);
				$dlg_val(callee) = $var(member);
				$(avp(r_name)[*]) = NULL;
				if ($var(member_name) != "")
					$avp(r_name) = $var(member_name);
			}
			route(event_attrs);
			raise_event("E_TWAKEPHONE_ANSWERED", $avp(ev_attr), $avp(ev_val));
		}
		# Who answered, as the directory names them (the caller's phone shows it): the callee, or the member. Not to
		# the operator (a call from the public network): nothing of the inside goes out.
		if ($rs >= 200 && $rs < 300 && $dlg_val(trunk) != "caller") {
			$var(pai_ext) = $avp(callee);
			$var(pai_name) = "";
			if ($var(member) != "") {
				$var(pai_ext) = $var(member);
				$var(pai_name) = $var(member_name);
			} else if ($avp(r_name) != NULL) {
				$var(pai_name) = $avp(r_name);
			}
			if ($var(pai_ext) =~ "^[A-Za-z0-9._+-]{1,64}$") {
				if ($var(pai_name) != "")
					append_hf("P-Asserted-Identity: \"$var(pai_name)\" <sip:$var(pai_ext)@$avp(domain)>\r\n");
				else
					append_hf("P-Asserted-Identity: <sip:$var(pai_ext)@$avp(domain)>\r\n");
			}
		}
	}
}

# The attributes of our events (E_TWAKEPHONE_*): who calls whom as dialled, and the Call-ID the CDR carries too. For a
# ring group, `group` (its number) and, for the ringing, the member's phone that rings as `callee` ($avp(ev_callee),
# used once).
route[event_attrs] {
	# Every value: `$avp(x) = NULL` only removes the last one, and these lists are built anew for each event.
	$(avp(ev_attr)[*]) = NULL;
	$(avp(ev_val)[*]) = NULL;
	$avp(ev_attr) = "callee";
	if ($avp(ev_callee) != NULL) {
		$avp(ev_val) = $avp(ev_callee);
		$(avp(ev_callee)[*]) = NULL;
	} else {
		$avp(ev_val) = $avp(callee);
	}
	if ($avp(group) != NULL) {
		$avp(ev_attr) = "group";
		$avp(ev_val) = $avp(group);
	}
	$avp(ev_attr) = "dialled";
	$avp(ev_val) = $avp(dialled);
	$avp(ev_attr) = "caller";
	$avp(ev_val) = $avp(caller);
	$avp(ev_attr) = "callid";
	$avp(ev_val) = $ci;
}

# The event the Gateway raises itself through the MI (`raise_event`) after each subscription to the events, and gets
# back: it then knows it hears OpenSIPS, and only then keeps the rows of `push_targets` alive (a Gateway whose events
# come from an address it does not accept wakes nobody: no call waits for it). Never called: a route that names an
# event is enough for OpenSIPS to know it.
route[probe_event] {
	raise_event("E_TWAKEPHONE_PROBE");
}

failure_route[call_failed] {
	# No transaction can be held from here (route[relay_call]).
	$var(relay_request) = 0;
	# Cancelled: the media session is over, free rtpengine's ports; the missed call is the callee's.
	if (t_was_cancelled()) {
		rtpengine_delete();
		if ($avp(group) != NULL)
			route(group_missed, "487 Request Terminated");
		route(account_missed);
		exit;
	}
	# A ring group nobody answered: no forward. The caller is told the group declined only when every window did
	# (tm's choice, a 6xx); else, a member declining or busy while the others did not answer, the group was not
	# reachable: 480, not the refusal of one of them.
	if ($avp(group) != NULL) {
		rtpengine_delete();
		if ($avp(g_declines) != NULL && $avp(g_declines) >= $avp(g_windows)) {
			$var(group_reply) = "" + $T_reply_code + " " + $(<reply>rr);
			route(group_missed, $var(group_reply));
			exit;
		}
		route(group_missed, "480 Temporarily Unavailable");
		t_reply(480, "Temporarily Unavailable");
		exit;
	}
	$var(dnd_code) = $T_reply_code;
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
		route(rules_local);
		if ($rc == 2) {
			# The same offer (rtpengine's, from the request route) goes to the new callee: its answer completes it.
			$dlg_val(callee) = $avp(callee);
			route(forwarded, $var(from), $var(code));
			t_on_reply("rtp");
			t_on_failure("call_failed");
			route(arm_failure);
			route(relay_call);
			exit;
		}
		$(avp(callee)[*]) = NULL;
		$avp(callee) = $var(from);
		$acc_extra(callee) = $var(from);
	}
	# Nothing follows. The call came here by a forward from an extension that does not want to be disturbed: its
	# refusal, with its message (whoever it was forwarded to did not answer, or refused: not the dialled one).
	if ($avp(d_dnd) == 1)
		route(dnd_refuse_dialled);
	# Else the caller gets the best failure (the one tm picked, for the extension that rang), the media session is
	# freed, the missed call accounted.
	rtpengine_delete();
	route(account_missed);
}
