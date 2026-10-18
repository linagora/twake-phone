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
# written by the Gateway; the emergency numbers go out whatever the policy. Step 8 (ADR 0018): LiveKit SIP, the phone
# access of Meet's rooms, sees no other trunk than this OpenSIPS, on a UDP socket of its own (route[meet_call],
# route[meet_source]): a call to the access number (MEET_NUMBER) goes to it, which asks for the room's PIN; a call it
# places for a room (dial-out) answers our challenge, is the call of the person who asked for it (their extension in
# the From) and follows the path of a call from their phone, the rules of the calls to the public network included.
# Step 11a (ADR 0022): a call that nothing else takes (a "do not disturb", busy or declined, no answer, nobody to ring,
# after the forwards and the fallback of a direct number) goes to the mailbox of the extension dialled
# (`voicemail_boxes`, written by the Gateway), on Wazo's Asterisk, on a UDP socket of its own (route[voicemail]).
# Everything in here is OpenSIPS-specific; the Gateway only knows `provider-opensips`.

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
# for the next ones: at most DB_MAX_ASYNC_CONNECTIONS per process (8 by default). The SIP processes are udp_workers
# for each UDP socket (the phones', the trunk's, LiveKit SIP's: 6; with Wazo's, 8) and tcp_workers (4): 10 (12), so
# 80 connections (96) at most, with about one more per process for the rest (registrations, dialogs, CDRs) and the
# Gateway's: the database's
# max_connections must hold them all (200 on this stack; docker/README.md). Past that number, OpenSIPS 3.6 runs the read
# synchronously but drops its result: the read fails (-1) at once, its row never read. The reads a call cannot go
# without (the direct number of a call from the operator, the trunk of a call to it) are made again then, synchronously
# (route[read_again]), when the failure came at once (a read past its time, RULES_QUERY_TIMEOUT_MS, is not made again);
# the rules and the ring groups are read again once as any failed read (route[read_failed]). twake_outbound() and a
# room's grant change what they read: never made twice (a reservation made for nothing is withdrawn, route[outbound_loaded]).
db_max_async_connections=${DB_MAX_ASYNC_CONNECTIONS}

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
# The socket of LiveKit SIP (step 8, ADR 0018): it hears LiveKit SIP's address only (MEET_SIP). None at all when Meet is
# off (MEET_ON 0, entrypoint.sh). On the loopback by default, like the others.
${MEET_SOCKET}
# The socket of Wazo's Asterisk (step 11a, ADR 0022): it hears that Asterisk only (WAZO_SIP), and only within the calls
# this OpenSIPS sent to a mailbox. None at all when Wazo is off (WAZO_ON 0, entrypoint.sh).
${WAZO_SOCKET}

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
# LiveKit SIP's credentials (step 8, route[meet_source]): one account, outside `subscriber` (no phone may register or
# call with it), its HA1 only (for the realm SIP_DOMAIN, made by entrypoint.sh from MEET_SIP_PASSWORD).
modparam("auth", "username_spec", "$var(meet_user)")
modparam("auth", "password_spec", "$var(meet_ha1)")

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
# The calls in progress are kept in the database too (`dialog`, written every 5 s, step 6b): OpenSIPS restarted (a
# crash, an update) reads them back, with their timers (TRUNK_MAX_CALL_SEC, the minutes allotted), their dialog
# profiles (the calls at the same time the caps count) and what acc needs for their CDR: a BYE after the restart ends
# the call on both sides and writes its CDR. Lost at a crash: a call still ringing, whatever its age (a dialog is
# written once answered), and one answered less than 5 s before; the minutes reserved for them are released before
# OpenSIPS starts again (entrypoint.sh, twake_outbound_restart()), and the emergency calls restored end within
# EMERGENCY_RESTORED_SEC (2 h: their phone is never asked about). fraud_detection keeps its counters in memory only:
# they start again from zero (ADR 0017; the caps, kept in `outbound_usage`, do not).
modparam("dialog", "db_mode", 2)
modparam("dialog", "db_url", "${OPENSIPS_DB_URL}")
modparam("dialog", "db_update_period", 5)
# Their values ($dlg_val, acc's context) and profiles written as they change, not only at shutdown: a crash keeps them.
modparam("dialog", "db_flush_vals_profiles", 1)
modparam("dialog", "default_timeout", 14400)
# A call with the operator (ADR 0016) lives as long as its phone does: OpenSIPS sends that side an OPTIONS in the
# dialog every CALL_PING_SEC (create_dialog flags P and p), and a phone that does not answer it within
# CALL_PING_TIMEOUT_SEC (local_route: put to sleep, its page closed or reloaded, its network gone) or no longer knows
# the call (481) has the call ended, a BYE to both sides: the operator's leg is never left open and charged. One
# missed OPTIONS is enough (dialog has no count of failures): a phone silent for less than CALL_PING_TIMEOUT_SEC keeps
# its call (over UDP, tm sends the OPTIONS again meanwhile, every 4 s at most), one silent for longer while an OPTIONS
# waits loses it, so a phone gone is noticed within CALL_PING_SEC + CALL_PING_TIMEOUT_SEC. Any other answer (200,
# 405, 501...) says the phone is there. Never an emergency call (route[trunk_out_loaded]: no P): the emergency
# services hang up themselves. Nothing else ends a call: not the app's own connection to the Gateway. Past
# TRUNK_MAX_CALL_SEC, a call with the operator ends too (create_dialog("B")), an emergency call excepted.
modparam("dialog", "options_ping_interval", ${CALL_PING_SEC})
# The calls to the public network in progress (step 6b, route[outbound_count]): per caller's extension, and all of them
# (one organisation per OpenSIPS). An emergency call is in neither, but in trunk_emergency: how a restart knows it.
# The calls to the access number of Meet's rooms in progress (step 8, route[meet_call]): per caller, and all of them.
modparam("dialog", "profiles_with_value", "trunk_caller;meet_caller;vm_caller")
modparam("dialog", "profiles_no_value", "trunk_out;trunk_emergency;meet_all;vm_all")
loadmodule "rtpengine.so"
modparam("rtpengine", "rtpengine_sock", "${RTPENGINE_SOCK}")

#### Directory names (step 4c, ADR 0014): the display name of the From is replaced by the caller's, as `display_names`
#### holds it (route[caller_name]). Only the display changes, never the URI or the tags: nothing to restore on the
#### way back, and the digest the caller computed (on the Request-URI) is checked before.
#### A call with the operator (step 6a) has its From and To URIs replaced (branch_route[trunk_out], route[caller_name]):
#### restored automatically (`auto`, kept in the dialog) in the answers and in every request of the call, both ways,
#### so that the operator only ever sees its own URIs and ours, never an extension nor the internal domain, including
#### in the BYE the dialog sends itself.
loadmodule "uac.so"
modparam("uac", "restore_mode", "auto")

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
# Whether the phone access of Meet's rooms is on (step 8, ADR 0018): MEET_SIP set (entrypoint.sh); and its access
# number. The Gateway reads both through the MI (shv_get) and says at its start when it has another view of them.
modparam("cfgutils", "shvset", "meet_on=i:${MEET_ON}")
modparam("cfgutils", "shvset", "meet_number=s:${MEET_NUMBER}")
# The longest a call with LiveKit SIP lasts (MEET_MAX_CALL_SEC): for the calls to come once changed (MI shv_set; the e2e
# shortens it a moment).
modparam("cfgutils", "shvset", "meet_max_sec=i:${MEET_MAX_CALL_SEC}")
# Whether the mailboxes of Wazo are on (step 11a, ADR 0022): WAZO_SIP set (entrypoint.sh). Off, no query names
# `voicemail_boxes`. When the database says that table is missing, the mailboxes are left out 30 s ($shv(no11_until)),
# as the tables of step 4c.
modparam("cfgutils", "shvset", "wazo_on=i:${WAZO_ON}")
modparam("cfgutils", "shvset", "no11_until=i:0")
# Wazo's Asterisk heard nothing from (a mailbox called, no answer at all within 2 s): the mailboxes are left out 30 s
# ($shv(wazo_mute_until), failure_route[voicemail_failed]), the calls get their refusal at once (review 11a, n°14).
modparam("cfgutils", "shvset", "wazo_mute_until=i:0")

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
#### only carry tags and the Call-ID. In the database, `external` too (step 6b): "out" for a call to the public
#### network, which the caps count (a trigger keeps `outbound_usage` as each CDR is written), "emergency" for an
#### emergency call, which they never do; and `via` (step 8): "meet" for a call a room of Meet placed at the name of
#### `caller`, not their phone.
loadmodule "acc.so"
modparam("acc", "db_url", "${OPENSIPS_DB_URL}")
modparam("acc", "extra_fields", "db: caller; callee; dialled; external; via")
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
# Volume thresholds (step 6b, ADR 0017): fraud_detection counts, per caller and per rule (numbers in France, +33, and
# every other one), the calls of the last minute, of the day, at the same time, in a row to the same number, and the
# duration of each; past a warning threshold it raises E_FRD_WARNING (the Gateway keeps it for the administrators),
# past a critical one E_FRD_CRITICAL and the call is refused (route[outbound_fraud]). Its rules, in `fraud_detection`,
# are the Gateway's (outbound.ts), reloaded on MI fraud_reload. It matches numbers through drouting's prefix tree:
# drouting is loaded for it alone, its tables empty, no call is ever routed by it.
loadmodule "drouting.so"
modparam("drouting", "db_url", "${OPENSIPS_DB_URL}")
loadmodule "fraud_detection.so"
modparam("fraud_detection", "db_url", "${OPENSIPS_DB_URL}")
# The default trunk as last read (timer_route[default_trunk]): what an emergency call takes when the database cannot
# say (route[default_trunk]). None until read. With it, the direct number of each extension on that trunk, in memory
# (cachedb_local, `dn:<extension>`): the caller's own number presented all the same (step 6b).
modparam("cfgutils", "shvset", "dt_setid=i:0")
# The generation of the direct numbers last read (timer_route[default_trunk]).
modparam("cfgutils", "shvset", "dn_gen=i:0")
loadmodule "cachedb_local.so"

#### Routing ###########################################################################################################

# A call has two sides, each of a kind: 0 one of our phones (a browser), 1 the operator (step 6), 2 LiveKit SIP (step 8).
# Towards a browser: DTLS-SRTP (RTP/SAVPF), rtcp-mux, ICE with rtpengine as the only candidate (the browsers never see
# each other's address, and a browser behind a NAT still works), SDP origin and connection rewritten. Towards the
# operator (step 6): plain RTP (RTP/AVP, no ICE, no DTLS nor SDES, RTCP on its own port), only the trunk's codecs
# and DTMF events ($dlg_val(codecs)). Towards LiveKit SIP (step 8): plain RTP likewise, in the codecs it speaks
# (G.722, G.711) and DTMF events (how a room's PIN is typed). A browser whose other side is not a browser is offered
# rtcp-mux and a=mid, as it expects. SIP INFO (DTMF) and the other in-dialog requests pass untouched.
route[rtp_flags] {
	$var(rtp_flags) = "ICE=force RTP/SAVPF rtcp-mux-require replace-origin replace-session-connection";
	if ($param(1) == 1)
		$var(rtp_flags) = "ICE=remove RTP/AVP rtcp-mux-demux DTLS=off SDES-off replace-origin replace-session-connection " + $dlg_val(codecs);
	else if ($param(1) == 2)
		$var(rtp_flags) = "ICE=remove RTP/AVP rtcp-mux-demux DTLS=off SDES-off replace-origin replace-session-connection codec-strip-all codec-except-G722 codec-except-PCMA codec-except-PCMU codec-except-telephone-event";
	else if ($dlg_val(trunk) != NULL || $dlg_val(meet) != NULL)
		$var(rtp_flags) = "ICE=force RTP/SAVPF rtcp-mux-require generate-mid SDES-off replace-origin replace-session-connection";
}

# The kind of the side the request in hand goes to ($var(to_kind)) and of the side it comes from ($var(from_kind)):
# the operator is the callee of an outbound call, the caller of an inbound one ($dlg_val(trunk)), LiveKit SIP the callee
# of a call to the access number, the caller of a call a room places ($dlg_val(meet)); an in-dialog request goes
# downstream (to the callee) or upstream (rr's ftag).
route[sides] {
	$var(callee_kind) = 0;
	$var(caller_kind) = 0;
	if ($dlg_val(trunk) == "callee")
		$var(callee_kind) = 1;
	else if ($dlg_val(meet) == "callee")
		$var(callee_kind) = 2;
	if ($dlg_val(trunk) == "caller")
		$var(caller_kind) = 1;
	else if ($dlg_val(meet) == "caller")
		$var(caller_kind) = 2;
	if (!has_totag() || is_direction("downstream")) {
		$var(to_kind) = $var(callee_kind);
		$var(from_kind) = $var(caller_kind);
	} else {
		$var(to_kind) = $var(caller_kind);
		$var(from_kind) = $var(callee_kind);
	}
}

# Whether the request in hand goes to the operator (1) or not (-1).
route[to_trunk] {
	if ($dlg_val(trunk) == NULL)
		return(-1);
	route(sides);
	if ($var(to_kind) == 1)
		return(1);
	return(-1);
}

# Whether the request in hand goes to LiveKit SIP (1) or not (-1).
route[to_meet] {
	if ($dlg_val(meet) == NULL)
		return(-1);
	route(sides);
	if ($var(to_kind) == 2)
		return(1);
	return(-1);
}

route[rtp_offer] {
	# The offer's side, for its answer (onreply_route[rtp]: it goes back there).
	route(sides);
	$(avp(offer_from)[*]) = NULL;
	$avp(offer_from) = $var(from_kind);
	route(rtp_flags, $var(to_kind));
	# LiveKit SIP draws the session id and version of its o= line as any 64-bit number (step 8), half of them past the
	# 2^63 - 1 that JSEP (RFC 8829) allows: Firefox refuses such an offer (488). rtpengine keeps them as they are; it is
	# given them as "1" and their last 17 digits instead (below 2^63, the same in each offer of the call, a version that
	# grows still grows).
	$var(offer_ok) = 0;
	if ($var(from_kind) == 2) {
		$var(sdp_re) = '/o=([^ ]+) [0-9]*([0-9]{17}) [0-9]*([0-9]{17}) IN /o=\1 1\2 1\3 IN /';
		$var(sdp_in) = $(rb{re.subst,$var(sdp_re)});
		if (rtpengine_offer("$var(rtp_flags)", , , $var(sdp_in)))
			$var(offer_ok) = 1;
	} else if (rtpengine_offer("$var(rtp_flags)")) {
		$var(offer_ok) = 1;
	}
	if ($var(offer_ok) != 1) {
		# Never relay the browser's own SDP: without rtpengine the call would go browser to browser.
		xlog("L_ERR", "rtpengine offer failed for $ci\n");
		send_reply(503, "Media Unavailable");
		exit;
	}
	# A session rtpengine holds for this call: a refusal after it (failure_route) frees it.
	$avp(rtp_on) = 1;
}
# An answer in a reply goes back the way its offer came ($param(1) unset); one in an ACK goes the way of the request
# ($param(1): the kind of the side it goes to).
route[rtp_answer] {
	$var(answer_to) = 0;
	if ($param(1) != NULL)
		$var(answer_to) = $param(1);
	else if ($avp(offer_from) != NULL)
		$var(answer_to) = $avp(offer_from);
	route(rtp_flags, $var(answer_to));
	if (!rtpengine_answer("$var(rtp_flags)"))
		xlog("L_ERR", "rtpengine answer failed for $ci\n");
}

# An INVITE without SDP (a "late offer", RFC 3264: an operator refreshing its session, or calling that way): the offer
# comes in the 2xx, back to whoever sent the INVITE (its kind, $avp(late_offer)), and the answer in the ACK. Both go
# through rtpengine (onreply_route[rtp], then the in-dialog ACK in the main route), never from one side to the other
# untouched.
route[late_offer] {
	route(sides);
	$(avp(late_offer)[*]) = NULL;
	$avp(late_offer) = "browser";
	if ($var(from_kind) == 1)
		$avp(late_offer) = "trunk";
	else if ($var(from_kind) == 2)
		$avp(late_offer) = "meet";
}
route[rtp_late_offer] {
	$var(offer_to) = 0;
	if ($avp(late_offer) == "trunk")
		$var(offer_to) = 1;
	else if ($avp(late_offer) == "meet")
		$var(offer_to) = 2;
	route(rtp_flags, $var(offer_to));
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
	# gateway or SBC sends its BYE or re-INVITE, and the CANCEL of an INVITE of the operator still ringing; anything
	# else is refused.
	$var(stranger) = 0;
	if ($socket_in(ip) == "${TRUNK_LISTEN_IP}" && $socket_in(port) == ${TRUNK_PORT} && !ds_is_in_list("$si", 0)) {
		if (is_method("CANCEL") && t_check_trans()) {
			xlog("L_NOTICE", "trunk: CANCEL of call $ci from $si:$sp, an address the trunk does not declare\n");
			t_relay();
			exit;
		}
		if (!has_totag()) {
			xlog("L_NOTICE", "trunk: $rm from $si:$sp refused, no address of the operator\n");
			if (!is_method("ACK"))
				send_reply(403, "Forbidden");
			exit;
		}
		$var(stranger) = 1;
	}

	# The socket of LiveKit SIP (step 8, ADR 0018) hears LiveKit SIP only: its address (MEET_SIP), any port, and nothing
	# when Meet is off. Its calls must still answer our challenge (below).
	$var(meet) = 0;
	if ($socket_in(ip) == "${MEET_LISTEN_IP}" && $socket_in(port) == ${MEET_PORT}) {
		if ($shv(meet_on) != 1 || $si != "${MEET_SIP_IP}") {
			xlog("L_NOTICE", "meet: $rm from $si:$sp refused, not LiveKit SIP\n");
			if (!is_method("ACK"))
				send_reply(403, "Forbidden");
			exit;
		}
		$var(meet) = 1;
	}

	# The socket of Wazo's Asterisk (step 11a, ADR 0022) hears that Asterisk only (WAZO_SIP), any port, and nothing when
	# Wazo is off. It never places a call (below); in a call to a mailbox, only its side speaks from there.
	$var(wazo) = 0;
	if ($socket_in(ip) == "${WAZO_LISTEN_IP}" && $socket_in(port) == ${WAZO_PORT}) {
		if ($shv(wazo_on) != 1 || $si != "${WAZO_SIP_IP}") {
			xlog("L_NOTICE", "wazo: $rm from $si:$sp refused, not Wazo's Asterisk\n");
			if (!is_method("ACK"))
				send_reply(403, "Forbidden");
			exit;
		}
		$var(wazo) = 1;
	}

	# In-dialog requests (ACK, BYE, re-INVITE for hold, INFO, REFER...) follow the Record-Route.
	if (has_totag()) {
		if (is_method("ACK") && $var(stranger) == 0 && t_check_trans()) {
			if (has_body_part("application/sdp")) {
				route(sides);
				route(rtp_answer, $var(to_kind));
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
		# From an address the trunk does not declare: only the operator's side of one of its calls, and only what a
		# media gateway or SBC sends in it (hang up, renegotiate the media, acknowledge).
		if ($var(stranger) == 1) {
			if ($dlg_val(trunk) == NULL || route(to_trunk) || !is_method("BYE|INVITE|ACK|UPDATE|PRACK")) {
				xlog("L_NOTICE", "trunk: $rm from $si:$sp refused, in no call with the operator or not allowed in one\n");
				if (!is_method("ACK"))
					send_reply(403, "Forbidden");
				exit;
			}
			xlog("L_NOTICE", "trunk: $rm of call $ci from $si:$sp, an address the trunk does not declare (accepted in this call)\n");
		}
		# LiveKit SIP's side of a call speaks from its socket, and nothing else does (step 8).
		$var(from_meet) = 0;
		if ($dlg_val(meet) != NULL) {
			route(sides);
			if ($var(from_kind) == 2)
				$var(from_meet) = 1;
		}
		if ($var(from_meet) != $var(meet)) {
			xlog("L_NOTICE", "meet: $rm of call $ci from $si:$sp refused, not LiveKit SIP's side of a call with it\n");
			if (!is_method("ACK"))
				send_reply(403, "Forbidden");
			exit;
		}
		# The mailbox's side of a call to it (step 11a: the callee, upstream) speaks from Wazo's socket, and nothing else
		# does; a mailbox never transfers.
		$var(from_wazo) = 0;
		if ($dlg_val(voicemail) == "1" && is_direction("upstream"))
			$var(from_wazo) = 1;
		if ($var(from_wazo) != $var(wazo) || ($dlg_val(voicemail) == "1" && is_method("REFER"))) {
			xlog("L_NOTICE", "wazo: $rm of call $ci from $si:$sp refused, not the mailbox's side of a call to it\n");
			if (!is_method("ACK"))
				send_reply(403, "Forbidden");
			exit;
		}
		# From the operator's side of a call to the phone's: to the phone of this dialog, at the Contact it gave
		# (fix_route_dialog), whatever the Request-URI says: the operator never had the phone's own (route[trunk_contact])
		# and nothing it sends can go anywhere else. Its answers go back to the operator (onreply_route[rtp]).
		$var(from_trunk) = 0;
		if ($dlg_val(trunk) != NULL && !route(to_trunk)) {
			$var(from_trunk) = 1;
			if (!fix_route_dialog()) {
				xlog("L_ERR", "call $ci: $rm from the operator not routed to the phone\n");
				if (!is_method("ACK"))
					send_reply(500, "Internal Error");
				exit;
			}
		}
		if (!is_method("INVITE|UPDATE|ACK|BYE|INFO|REFER|NOTIFY|PRACK|OPTIONS")) {
			send_reply(405, "Method Not Allowed");
			exit;
		}
		# Nothing in a call with the operator may have it place a call (step 6a, ADR 0016): a REFER (a transfer) would
		# have it call whatever the Refer-To says, on our account and past route[outbound_policy]. Refused whichever
		# side sends it: a transfer with an external party waits for one the platform makes itself. Likewise in a call
		# with LiveKit SIP (step 8): a room calls through the Gateway only, at the name of whoever asked.
		if (is_method("REFER") && ($dlg_val(trunk) != NULL || $dlg_val(meet) != NULL)) {
			xlog("L_NOTICE", "call $ci: REFER in a call with the operator or LiveKit SIP refused\n");
			if (route(to_trunk) || route(to_meet))
				append_to_reply("Twake-Call-Refused: transfer-external\r\n");
			send_reply(403, "Transfer Not Allowed");
			exit;
		}
		# To the operator, a request that says once what it is, with SDP as its only body (route[trunk_request]).
		if (route(to_trunk) && !route(trunk_request)) {
			xlog("L_NOTICE", "call $ci: $rm to the operator refused ($var(refuse_code))\n");
			if (is_method("ACK"))
				exit;
			if ($var(refuse_code) == 415)
				append_to_reply("Accept: application/sdp\r\n");
			send_reply($var(refuse_code), "$var(refuse_reason)");
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
			route(sides);
			route(rtp_answer, $var(to_kind));
		}
		if (is_method("BYE"))
			rtpengine_delete();
		# Who the parties are was said once, by this script, in the initial INVITE and its answer.
		remove_hf("P-Asserted-Identity");
		remove_hf("P-Preferred-Identity");
		remove_hf("Remote-Party-ID");
		# To the operator, only what a call needs (route[trunk_headers]), and a Contact without the extension
		# (route[trunk_contact]).
		if (route(to_trunk)) {
			route(trunk_headers);
			route(trunk_contact);
		}
		# From the operator to the phone: the phone's answers carry its Contact (onreply_route[rtp] rewrites it too).
		if ($var(from_trunk) == 1) {
			$avp(reply_to_trunk) = 1;
			t_on_reply("rtp");
		}
		# LiveKit SIP's requests in a call it answered name our sockets in reverse order (the route set a caller would
		# have, step 8): loose_route would send them from the socket they came to. They leave from the socket the call
		# came from (route[meet_call]).
		if ($var(from_meet) == 1 && $dlg_val(meet) == "callee" && $dlg_val(caller_sock) != NULL)
			$socket_out = $dlg_val(caller_sock);
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

	# The socket of Wazo's Asterisk (step 11a): its keepalives only. It calls nobody, and nothing registers there.
	if ($var(wazo) == 1) {
		if (is_method("ACK"))
			exit;
		if (is_method("OPTIONS")) {
			send_reply(200, "OK");
			exit;
		}
		xlog("L_NOTICE", "wazo: $rm from $si:$sp refused, Wazo places no call\n");
		send_reply(403, "Forbidden");
		exit;
	}

	# The socket of LiveKit SIP (step 8): the calls its rooms place (dial-out), and its keepalives. Nothing registers there.
	if ($var(meet) == 1) {
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

	# A call: the caller must be one of our accounts and call as itself. A call a room places (step 8) comes with
	# LiveKit SIP's own account (MEET_SIP_USER, its HA1 for our realm), and its From names the person who asked for it
	# (the Gateway's dial-out): one of our accounts, read after the transaction (route[meet_source]).
	if ($var(meet) == 1) {
		$var(meet_user) = "${MEET_SIP_USER}";
		$var(meet_ha1) = "${MEET_SIP_HA1}";
		if (!pv_proxy_authorize("${SIP_DOMAIN}")) {
			proxy_challenge("${SIP_DOMAIN}", "auth");
			exit;
		}
		if (!($fU =~ "^[A-Za-z0-9._+-]{1,64}$") || is_present_hf("Replaces")) {
			xlog("L_NOTICE", "meet: call $ci from $fU refused\n");
			send_reply(403, "Forbidden");
			exit;
		}
		# A room never calls its own access number (a loop through LiveKit SIP).
		if ($rU == "${MEET_NUMBER}") {
			send_reply(482, "Loop Detected");
			exit;
		}
		# The Gateway's grant of this very call (route[meet_source]), read here and never passed on.
		$avp(meet_grant) = "";
		if (is_present_hf("X-Twake-Grant"))
			$avp(meet_grant) = $hdr(X-Twake-Grant);
		remove_hf("X-Twake-Grant");
	} else {
		if (!proxy_authorize("", "subscriber")) {
			proxy_challenge("", "auth");
			exit;
		}
		if ($au != $fU) {
			send_reply(403, "Forbidden");
			exit;
		}
	}
	consume_credentials();
	# Who calls is told by this script only (the From's display, route[caller_name]): no identity a phone asserts
	# passes on. Nor that a room calls (Twake-Room), for which window (Twake-Join, step 8b) or from which conference
	# (Twake-Conference, review 8b, n°2): this script says it of the room's calls it let through
	# (route[meet_source_loaded]), never a phone nor LiveKit SIP.
	remove_hf("P-Asserted-Identity");
	remove_hf("P-Preferred-Identity");
	remove_hf("Remote-Party-ID");
	remove_hf("Twake-Room");
	remove_hf("Twake-Join");
	remove_hf("Twake-Conference");
	# Which mailbox takes a call, and with which greeting (step 11a, route[voicemail]): this script says it, never a phone.
	remove_hf("X-Twake-Mailbox");
	remove_hf("X-Twake-Voicemail");

	if ($rU == NULL) {
		send_reply(484, "Address Incomplete");
		exit;
	}

	# A number of the public network (step 6, ADR 0016): normalised to E.164 and classified by the numbering plan
	# (`dialplan`); only what route[outbound_policy] allows goes to the operator. An emergency number goes to it
	# whatever extension or group could have its digits. Anything else is an extension or a group, as before.
	$var(pstn) = 0;
	if (!is_present_hf("Replaces") && dp_translate(1, "$rU", $var(num), $var(num_class))) {
		# A room never calls an emergency number (step 8): an emergency call comes from a person's phone, whose
		# number and place the emergency services are given.
		if ($var(meet) == 1 && $var(num_class) == "emergency") {
			xlog("L_NOTICE", "meet: call $ci from $fU to $var(num) refused (emergency)\n");
			send_reply(403, "Emergency Calls Not From A Room");
			exit;
		}
		route(outbound_policy);
	}

	# The INVITE that completes an attended transfer (Replaces) goes where the call it replaces went: the extension
	# named in it may have forwarded that call elsewhere (the transferor dialled 104, 104's rules took it to 103).
	# Never into a call with the operator (step 6a) or LiveKit SIP (step 8): the platform does not transfer external
	# parties yet.
	$var(replaces_to) = "";
	$var(replaces_trunk) = 0;
	if (is_present_hf("Replaces"))
		route(replaces_target);
	if ($var(replaces_trunk) == 1) {
		xlog("L_NOTICE", "call $ci: Replaces of a call with the operator or LiveKit SIP refused\n");
		append_to_reply("Twake-Call-Refused: transfer-external\r\n");
		send_reply(403, "Transfer Not Allowed");
		exit;
	}

	# To the operator, an INVITE that says once what it is, with SDP as its only body (route[trunk_request]).
	if ($var(pstn) == 1 && !route(trunk_request)) {
		xlog("L_NOTICE", "call $ci: $fU to $var(num) refused ($var(refuse_code))\n");
		if ($var(num_class) == "emergency")
			append_to_reply("Twake-Call-Refused: emergency\r\n");
		if ($var(refuse_code) == 415)
			append_to_reply("Accept: application/sdp\r\n");
		send_reply($var(refuse_code), "$var(refuse_reason)");
		exit;
	}

	record_route();
	fix_nated_contact();
	# The Contact the operator will get (route[trunk_contact]), read now, as fix_nated_contact just made it: before the
	# trunk is read asynchronously, after which the request is tm's copy of it.
	if ($var(pstn) == 1)
		$avp(t_contact) = $(ct.fields(uri){re.subst,/^(sips?):[^@;]*@/\1:/});
	# A call to the operator gets its flags once it is known to go there (route[trunk_out_loaded]): its caller's
	# phone asked whether it is still there (P), the call ended past its longest duration (B). One of our own direct
	# numbers dialled stays an internal call, without either.
	create_dialog();
	if ($var(meet) == 1) {
		$dlg_val(meet) = "caller";
		$acc_extra(via) = "meet";
	}

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

	# A room's call (step 8): whoever its From names must be one of our accounts (route[meet_source]).
	if ($var(meet) == 1) {
		route(meet_source);
		exit;
	}

	# The access number of Meet's rooms (step 8): to LiveKit SIP (route[meet_call]).
	if ($shv(meet_on) == 1 && $var(pstn) == 0 && !is_present_hf("Replaces") && $rU == "${MEET_NUMBER}") {
		route(meet_call);
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

#### Meet (step 8, ADR 0018) ###########################################################################################
# LiveKit SIP, the phone access of Meet's rooms, sees no other trunk than this proxy, on a socket of its own
# (MEET_LISTEN_IP:MEET_PORT, the main route: its address only, MEET_SIP). Both ways:
# - a call to the access number (MEET_NUMBER), from one of our phones or from the operator on a direct number that
#   aims at it, goes to LiveKit SIP, which asks for the room's PIN (route[meet_call]);
# - a call a room places (the Gateway's dial-out) answers our challenge with LiveKit SIP's account, names in its From
#   the person who asked for it, one of our accounts, and carries the Gateway's grant of that very call (X-Twake-Grant,
#   a row of `dial_out_grants` the Gateway wrote just before: that person, that number, single use, a few seconds to
#   live): LiveKit SIP's account alone, which anyone with an API key of the LiveKit server can read back, makes no call
#   anyone's. It is then that person's call: an extension or a group as from their phone, a number of the public
#   network with their rights, caps, volume thresholds and direct number (route[trunk_out]), never longer than
#   MEET_MAX_CALL_SEC; never an emergency number nor the access number. The callee's phone shows "Meet (<name>)".
# - a call to the access number is a try of a room's PIN (one per call, LiveKit SIP): counted for its caller when it
#   comes, given back if LiveKit SIP does not answer it (route[meet_call], failure_route[meet_failed]), whatever then
#   happens in it (a right PIN, a wrong one typed at once or after an hour). A caller with MEET_PIN_TRIES of them in 10
#   minutes is refused (403, pin-tries) for the rest of those 10 minutes; those who hide their number share one count,
#   refused past MEET_PIN_TRIES_ALL. A caller has MEET_CALLS_PER_CALLER calls to it at the same time at most (486,
#   meet-busy; those who hide their number together MEET_CALLS_ALL), all callers MEET_CALLS_ALL (503, meet-full). The
#   administrators are told (E_TWAKEPHONE_PIN, once per 10 minutes for each) when the calls of all callers in 10
#   minutes reach MEET_PIN_TRIES_ALL (pin-tries) and when MEET_CALLS_ALL are in progress (calls). The counts of 10
#   minutes are in memory, this OpenSIPS's only, forgotten when it restarts. A call with LiveKit SIP lasts
#   MEET_MAX_CALL_SEC at most ($shv(meet_max_sec)), then BYE to both sides.
# The media through rtpengine, plain RTP on LiveKit SIP's side (route[rtp_flags]).

# A room's call: its grant taken (used once), for whoever its From names, one of our accounts, and the number it calls
# as the Gateway gave it to LiveKit (the Request-URI), read without holding this process. Only the characters of a
# grant (32 hexadecimal), of a number, of a tag and of a Call-ID get into the query. The grant is not deleted but marked
# with the call that took it (review 8b, n°3): the From tag LiveKit SIP writes is the id of its call, which LiveKit gives
# the Gateway (CreateSIPParticipant's sip_call_id). The Gateway compares the two once the call is through: a grant taken
# by another call (someone holding a key of LiveKit replays it from a room of theirs while the Gateway's own call goes
# where they sent LiveKit's trunk) is a call diverted, which it ends (the room, and this dialog by its Call-ID). Kept 10
# minutes for that, then the Gateway's next grant deletes it. With the grant, what it says of a conference (step 8b,
# ADR 0019): the call it takes the place of (`replaces`), the window it is for (`join_token`), its room (`room`).
route[meet_source] {
	$avp(meet_pstn) = $var(pstn);
	if (!($avp(meet_grant) =~ "^[0-9a-f]{32}$") || !($rU =~ "^[+]?[0-9*#]{2,20}$") || !($ft =~ "^[A-Za-z0-9._~!%*+-]{1,64}$") || !($ci =~ "^[A-Za-z0-9._~!%*+@:-]{1,200}$")) {
		xlog("L_NOTICE", "meet: call $ci from $avp(caller) to $rU refused, without a grant\n");
		append_to_reply("Twake-Call-Refused: not-granted\r\n");
		t_reply(403, "Not Granted");
		exit;
	}
	$var(meet_query) = "UPDATE dial_out_grants g SET used_by = '" + $ft + "', used_call = '" + $ci + "', expires_at = now() + interval '10 minutes' WHERE g.token = '" + $avp(meet_grant) + "' AND g.used_by IS NULL AND g.extension = '" + $fU + "' AND g.number = '" + $rU + "' AND g.expires_at > now() AND EXISTS (SELECT 1 FROM subscriber s WHERE s.username = g.extension) RETURNING 1, coalesce(g.replaces, ''), coalesce(g.join_token, ''), coalesce(g.room, '')";
	async(sql_query_one("$var(meet_query)", "$avp(meet_known);$avp(meet_replaces);$avp(meet_join);$avp(meet_room)"), meet_source_loaded);
}

route[meet_source_loaded] {
	$var(meet_rc) = $rc;
	if (t_was_cancelled()) {
		t_reply(487, "Request Terminated");
		exit;
	}
	if ($var(meet_rc) == -2) {
		xlog("L_NOTICE", "meet: call $ci from $avp(caller) to $rU refused: no grant of the Gateway for it (used, past its time, another person or number), or none of our accounts\n");
		append_to_reply("Twake-Call-Refused: not-granted\r\n");
		t_reply(403, "Not Granted");
		exit;
	}
	if ($var(meet_rc) < 0) {
		xlog("L_WARN", "meet: call $ci from $avp(caller), its grant not read ($var(meet_rc))\n");
		t_reply(503, "Service Unavailable");
		exit;
	}
	if (($avp(meet_replaces) != NULL && $avp(meet_replaces) != "") || ($avp(meet_join) != NULL && $avp(meet_join) != "")) {
		route(conference_leg);
		exit;
	}
	if ($avp(meet_pstn) == 1) {
		route(trunk_out);
		exit;
	}
	# The callee's phone knows a room calls (no hold nor transfer there: the room's calls are not transferred). The
	# room of a conference (review 8b, n°2) says so, and which: whoever answers sees who is in it. A call of the
	# conference as the others' are (second review 8b, n°8): its CDR says `via` conference, its events `conference`
	# (its callee's: the Récents of the third participant say Conférence, as their window does).
	if ($avp(meet_room) =~ "^twake-call-[0-9a-f]{16}$") {
		append_hf("Twake-Room: conference\r\n");
		append_hf("Twake-Conference: $avp(meet_room)\r\n");
		$avp(conference) = 1;
		$acc_extra(via) = "conference";
	} else
		append_hf("Twake-Room: meet\r\n");
	route(rules_next);
	exit;
}

# A room's call of a conference (step 8b, ADR 0019), as its grant says: in the place of a call of the extension it
# calls (Replaces, the dialog the Gateway read from this proxy: its phone that has the call answers at once and ends
# that call), or to the person who makes the conference (Twake-Join, the token their window drew: only that window
# answers). To the phones of that extension and nowhere else: no rules (a forward, a "do not disturb"), no ring group,
# never the public network. Its CDR says `via` conference; its events, `conference`.
route[conference_leg] {
	if ($avp(meet_pstn) == 1) {
		xlog("L_NOTICE", "meet: conference call $ci from $avp(caller) to $rU refused: not an extension\n");
		append_to_reply("Twake-Call-Refused: not-granted\r\n");
		t_reply(403, "Not Granted");
		exit;
	}
	# What the grant says goes into headers of our own: only as the Gateway writes it (review 8b, n°15).
	if (($avp(meet_replaces) != "" && !($avp(meet_replaces) =~ "^[A-Za-z0-9._~!%*+@:-]{1,200};to-tag=[A-Za-z0-9._~!%*+-]{1,50};from-tag=[A-Za-z0-9._~!%*+-]{1,50}$")) || ($avp(meet_join) != "" && !($avp(meet_join) =~ "^[0-9a-f]{32}$")) || ($avp(meet_room) != "" && !($avp(meet_room) =~ "^twake-call-[0-9a-f]{16}$"))) {
		xlog("L_WARN", "meet: conference call $ci from $avp(caller) to $rU refused: its grant is not as the Gateway writes one\n");
		t_reply(500, "Server Internal Error");
		exit;
	}
	# The phone must take it in the place of the call, or refuse it (RFC 3891, 420): never ring it as a new call.
	if ($avp(meet_replaces) != "") {
		append_hf("Replaces: $avp(meet_replaces)\r\n");
		append_hf("Require: replaces\r\n");
	} else
		append_hf("Twake-Join: $avp(meet_join)\r\n");
	append_hf("Twake-Room: conference\r\n");
	if ($avp(meet_room) != "")
		append_hf("Twake-Conference: $avp(meet_room)\r\n");
	$avp(conference) = 1;
	$acc_extra(via) = "conference";
	if (!lookup("location")) {
		route(account_missed);
		route(calling);
		t_reply(404, "Not Found");
		exit;
	}
	route(names_next);
	exit;
}

# A call to the access number: to LiveKit SIP, from its socket. No rules, groups nor windows: the number is nobody's.
# Never from LiveKit SIP itself (a room calling one of our direct numbers that aims at it). The socket the call came
# from is kept for LiveKit SIP's requests in the call (main route).
route[meet_call] {
	if ($dlg_val(meet) == "caller") {
		xlog("L_NOTICE", "meet: call $ci, a room calling its own access, refused\n");
		t_reply(482, "Loop Detected");
		exit;
	}
	# Who calls: the extension, the operator's caller; `anonymous` for all who hide their number.
	$var(pin_who) = "other";
	if ($avp(caller) =~ "^[A-Za-z0-9._+-]{1,64}$")
		$var(pin_who) = $avp(caller);
	$var(pin_cap) = ${MEET_PIN_TRIES};
	$var(m_cap) = ${MEET_CALLS_PER_CALLER};
	if ($var(pin_who) == "anonymous" || $var(pin_who) == "other") {
		$var(pin_cap) = ${MEET_PIN_TRIES_ALL};
		$var(m_cap) = ${MEET_CALLS_ALL};
	}
	# The calls to the access number at the same time, this one counted in, under a lock: of two calls at once, one
	# counts the other. Its dialog leaves the profiles when it ends, refused or not.
	get_static_lock("meet_count");
	set_dlg_profile("meet_caller", "$var(pin_who)");
	set_dlg_profile("meet_all");
	get_profile_size("meet_caller", "$var(pin_who)", $var(m_mine));
	get_profile_size("meet_all", , $var(m_all));
	release_static_lock("meet_count");
	if ($var(m_all) > ${MEET_CALLS_ALL}) {
		xlog("L_WARN", "meet: call $ci from $avp(caller) to the access number refused: $var(m_all) calls to it at the same time\n");
		route(meet_alert, "calls", $var(m_all), ${MEET_CALLS_ALL});
		append_to_reply("Twake-Call-Refused: meet-full\r\n");
		t_reply(503, "Service Unavailable");
		exit;
	}
	if ($var(m_mine) > $var(m_cap)) {
		xlog("L_NOTICE", "meet: call $ci from $avp(caller) to the access number refused: $var(m_mine) calls of it at the same time\n");
		append_to_reply("Twake-Call-Refused: meet-busy\r\n");
		t_reply(486, "Busy Here");
		exit;
	}
	# A try of a PIN, counted now (calls at once count each other), given back if LiveKit SIP does not answer it
	# (failure_route[meet_failed]): past MEET_PIN_TRIES of this caller in 10 minutes from the first one
	# (MEET_PIN_TRIES_ALL for `anonymous`), refused before LiveKit SIP. Never for what other callers tried.
	$var(pin_n) = 0;
	cache_add("local", "pin:c:$var(pin_who)", 1, 600, $var(pin_n));
	if ($var(pin_n) > $var(pin_cap)) {
		xlog("L_WARN", "meet: call $ci from $avp(caller) to the access number refused: $var(pin_n) calls of it in 10 minutes\n");
		append_to_reply("Twake-Call-Refused: pin-tries\r\n");
		t_reply(403, "Too Many Tries");
		exit;
	}
	$avp(pin_who) = $var(pin_who);
	# All callers' tries in 10 minutes: at MEET_PIN_TRIES_ALL, the administrators hear it (at the latest when those who
	# hide their number reach their cap, the same number); nobody is refused for it.
	$var(pin_all) = 0;
	cache_add("local", "pin:all", 1, 600, $var(pin_all));
	if ($var(pin_all) >= ${MEET_PIN_TRIES_ALL})
		route(meet_alert, "pin-tries", $var(pin_all), ${MEET_PIN_TRIES_ALL});
	$dlg_val(meet) = "callee";
	# Never longer than MEET_MAX_CALL_SEC, then BYE to both sides (B; a call from the operator has it already, with its
	# phone ping): LiveKit SIP answers any OPTIONS, a LiveKit SIP gone in the middle of the call is not noticed otherwise.
	if ($dlg_val(trunk) == NULL)
		create_dialog("B");
	if ($DLG_timeout > $shv(meet_max_sec))
		$DLG_timeout = $shv(meet_max_sec);
	$dlg_val(caller_sock) = $socket_in;
	$dlg_val(callee) = $avp(callee);
	$dlg_val(dialled) = $avp(dialled);
	$ru = "sip:${MEET_NUMBER}@${MEET_SIP}";
	$socket_out = "udp:${MEET_LISTEN_IP}:${MEET_PORT}";
	route(caller_name);
	if (has_body_part("application/sdp"))
		route(rtp_offer);
	else
		route(late_offer);
	t_on_reply("rtp");
	t_on_failure("meet_failed");
	# LiveKit SIP answers at once (the PIN is asked once answered) or never (no room's rule: it rings and drops the
	# call): 15 s, not fr_inv_timeout, before it is given up and its try given back.
	$T_fr_inv_timeout = 15;
	route(account_missed);
	route(calling);
	if (!t_relay()) {
		if ($avp(rtp_on) != NULL)
			rtpengine_delete();
		t_reply(503, "Service Unavailable");
	}
	exit;
}

# Not answered by LiveKit SIP (refused, busy, given up, nobody answered in time): no try of a PIN, given back.
failure_route[meet_failed] {
	if ($avp(rtp_on) != NULL)
		rtpengine_delete();
	if ($avp(pin_who) == NULL)
		return;
	$var(left) = 0;
	cache_sub("local", "pin:c:$avp(pin_who)", 1, 600, $var(left));
	if ($var(left) <= 0)
		cache_remove("local", "pin:c:$avp(pin_who)");
	$var(left) = 0;
	cache_sub("local", "pin:all", 1, 600, $var(left));
	if ($var(left) <= 0)
		cache_remove("local", "pin:all");
}

# Tells the administrators (E_TWAKEPHONE_PIN) about the access number: $param(1) "pin-tries" (the tries of all callers
# in 10 minutes) or "calls" (at the same time), its value $param(2) and threshold $param(3); once per 10 minutes each.
route[meet_alert] {
	$var(told) = 0;
	cache_add("local", "pin:told:$param(1)", 1, 600, $var(told));
	if ($var(told) != 1)
		return(1);
	xlog("L_WARN", "meet: $param(2) $param(1) to the access number, MEET's threshold $param(3)\n");
	$(avp(ev_attr)[*]) = NULL;
	$(avp(ev_val)[*]) = NULL;
	$avp(ev_attr) = "param";
	$avp(ev_val) = $param(1);
	$avp(ev_attr) = "number";
	$avp(ev_val) = "${MEET_NUMBER}";
	$avp(ev_attr) = "value";
	$avp(ev_val) = $param(2);
	$avp(ev_attr) = "threshold";
	$avp(ev_val) = $param(3);
	raise_event("E_TWAKEPHONE_PIN", $avp(ev_attr), $avp(ev_val));
	return(1);
}

#### Trunks (step 6, ADR 0016) #########################################################################################
# What may go out, in 6a (numbering.ts): the emergency numbers, always, as dialled (route[trunk_out_loaded]); the
# European harmonised numbers (116xxx, free), as dialled, as far as the trunk calls free numbers; the fixed, mobile,
# free, standard-rate, overseas and international numbers, as far as the trunk allows them (its `allowed`: by default
# the metropolitan fixed, mobile, free and standard-rate ones, OUTBOUND_ALLOWED; an international number only to the
# country codes its `countries` lists); premium numbers never, satellite and international premium ones included
# (then, once the trunk is read, the caller's rights, the caps and the volume thresholds of step 6b:
# route[trunk_out_loaded]). A refusal comes before any transaction, with its reason for the app
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
# operator). Small tables only: an emergency call reads nothing else (the rules of step 6b come after, in a query of
# their own, for the other calls: route[outbound_query]). The caller is one of our accounts (digest), its user name
# has only the characters of `subscriber`; the number called, digits and a +.
route[trunk_out] {
	$var(ext) = "";
	if ($avp(caller) =~ "^[A-Za-z0-9._+-]{1,64}$")
		$var(ext) = $avp(caller);
	$var(called) = "";
	if ($avp(callee) =~ "^\+?[0-9]{2,16}$")
		$var(called) = $avp(callee);
	$(avp(trunk_query)[*]) = NULL;
	$var(trunk_query) = "SELECT t.setid, t.domain, t.number_format, t.assert_identity, t.auth_username, t.auth_password, t.auth_realm, t.codec_flags, coalesce(d.number, t.default_number) AS presented, t.allowed, t.countries, (SELECT CASE WHEN i.suffix_digits > 0 THEN right('" + $var(called) + "', i.suffix_digits) ELSE i.target END FROM dids i WHERE length(i.first_number) = length('" + $var(called) + "') AND '" + $var(called) + "' BETWEEN i.first_number AND i.last_number ORDER BY i.suffix_digits LIMIT 1) AS internal FROM trunks t LEFT JOIN LATERAL (SELECT CASE WHEN x.suffix_digits > 0 THEN left(x.first_number, length(x.first_number) - x.suffix_digits) || '" + $var(ext) + "' ELSE x.first_number END AS number FROM dids x WHERE x.trunk_id = t.id AND ((x.suffix_digits = 0 AND x.target = '" + $var(ext) + "') OR (x.suffix_digits = length('" + $var(ext) + "') AND left(x.first_number, length(x.first_number) - x.suffix_digits) || '" + $var(ext) + "' BETWEEN x.first_number AND x.last_number)) ORDER BY x.suffix_digits, x.first_number LIMIT 1) d ON true ORDER BY (d.number IS NULL), t.position LIMIT 1";
	$avp(trunk_query) = $var(trunk_query);
	route(read_sent);
	async(sql_query_one("$var(trunk_query)", "$avp(t_setid);$avp(t_domain);$avp(t_format);$avp(t_pai);$avp(t_user);$avp(t_pass);$avp(t_realm);$avp(t_codecs);$avp(t_presented);$avp(t_allowed);$avp(t_countries);$avp(t_internal)"), trunk_out_loaded);
}

# An emergency call must not depend on the database (ADR 0016): the default trunk as this process last read it
# (timer_route[default_trunk], every 15 s), whatever the database says now. Its servers are in OpenSIPS's memory
# (dispatcher). Taken when the trunk of the call could not be read, or when none of its servers is up and the default
# trunk is another one; the caller's own direct number on that trunk presented, as last read
# (however long ago: second review 6b, n°1), else the trunk's own number. Returns -1 when it has none, or it is the
# trunk tried already.
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
	# "<number>|<generation>": one of the last read that succeeded (an extension that lost its number then is not).
	if ($avp(caller) =~ "^[A-Za-z0-9._+-]{1,64}$" && cache_fetch("local", "dn:$avp(caller)", $var(dn)) && $(var(dn){s.select,1,|}) =~ "^[0-9]+$" && $(var(dn){s.select,1,|}{s.int}) >= $shv(dn_gen) && $(var(dn){s.select,0,|}) =~ "^\+[1-9][0-9]{6,14}$")
		$avp(t_presented) = $(var(dn){s.select,0,|});
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
		# The direct number of each extension on it (5000 at most), kept until a read succeeds again (second review 6b,
		# n°1: a database down for longer than a read's period must not change the number an emergency call
		# presents): written with the next generation, which only then becomes the one read; an extension absent
		# from it keeps an older one, never read again (route[default_trunk]).
		$(avp(dn_ext)[*]) = NULL;
		$(avp(dn_num)[*]) = NULL;
		if (sql_query("SELECT s.username, d.number FROM subscriber s CROSS JOIN LATERAL (SELECT CASE WHEN x.suffix_digits > 0 THEN left(x.first_number, length(x.first_number) - x.suffix_digits) || s.username ELSE x.first_number END AS number FROM dids x WHERE x.trunk_id = (SELECT id FROM trunks ORDER BY position LIMIT 1) AND ((x.suffix_digits = 0 AND x.target = s.username) OR (x.suffix_digits = length(s.username) AND left(x.first_number, length(x.first_number) - x.suffix_digits) || s.username BETWEEN x.first_number AND x.last_number)) ORDER BY x.suffix_digits, x.first_number LIMIT 1) d LIMIT 5000", "$avp(dn_ext);$avp(dn_num)")) {
			$var(dn_next) = $shv(dn_gen) + 1;
			$var(i) = 0;
			while ($(avp(dn_ext)[$var(i)]) != NULL) {
				$var(dn_key) = "dn:" + $(avp(dn_ext)[$var(i)]);
				# The number first: a string, to which "+" adds the generation as text (an integer first would add).
				$var(dn_val) = $(avp(dn_num)[$var(i)]) + "|" + $var(dn_next);
				cache_store("local", "$var(dn_key)", "$var(dn_val)", 0);
				$var(i) = $var(i) + 1;
			}
			$shv(dn_gen) = $var(dn_next);
		}
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
	if ($var(trunk_rc) == -1 && route(read_again)) {
		sql_query_one("$avp(trunk_query)", "$avp(t_setid);$avp(t_domain);$avp(t_format);$avp(t_pai);$avp(t_user);$avp(t_pass);$avp(t_realm);$avp(t_codecs);$avp(t_presented);$avp(t_allowed);$avp(t_countries);$avp(t_internal)");
		$var(trunk_rc) = $rc;
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
		if ($shv(meet_on) == 1 && $var(internal) == "${MEET_NUMBER}") {
			route(meet_call);
			exit;
		}
		route(rules_next);
		exit;
	}
	# A call to the operator from here on: the caller's phone is asked whether it is still there (P, not for an
	# emergency call: the emergency services hang up themselves, a phone silent a few seconds must never cut them), the
	# call ends past its longest duration (B, $DLG_timeout below): BYE to both.
	if ($avp(num_class) == "emergency") {
		create_dialog("B");
		set_dlg_profile("trunk_emergency");
		$acc_extra(external) = "emergency";
	} else {
		create_dialog("BP");
		$acc_extra(external) = "out";
	}
	# What the trunk may call: an emergency number always, anything else as its `allowed` says (",fixed,mobile,"),
	# an international number only to a country code its `countries` lists (",32,44,": E.164 country codes, of one to
	# three digits, are none the start of another). The North American plan (+1) is one code for many countries: `1`
	# opens the United States and Canada only, any other of its countries is listed by its area ("1876", Jamaica),
	# as dialplan's set 4 knows them (numbering.ts).
	if ($avp(num_class) != "emergency") {
		$var(mark) = "," + $avp(num_class) + ",";
		$var(allowed) = 1;
		if ($avp(t_allowed) == NULL || $(avp(t_allowed){s.index,$var(mark)}) == NULL)
			$var(allowed) = 0;
		if ($avp(num_class) == "international" && $var(allowed) == 1) {
			$var(allowed) = 0;
			if ($avp(t_countries) == NULL) {
				$var(allowed) = 0;
			} else if ($avp(callee) =~ "^\+1") {
				# Its area, listed ("1876"); or "1" for an area of the United States or Canada (none of set 4).
				$var(cc) = "," + $(avp(callee){s.substr,1,4}) + ",";
				if ($(avp(t_countries){s.index,$var(cc)}) != NULL)
					$var(allowed) = 1;
				$var(cc) = ",1,";
				if ($(avp(t_countries){s.index,$var(cc)}) != NULL && !dp_translate(4, "$avp(callee)", $var(nanp)))
					$var(allowed) = 1;
			} else {
				$var(i) = 1;
				while ($var(i) <= 3) {
					$var(cc) = "," + $(avp(callee){s.substr,1,$var(i)}) + ",";
					if ($(avp(t_countries){s.index,$var(cc)}) != NULL)
						$var(allowed) = 1;
					$var(i) = $var(i) + 1;
				}
			}
		}
		if ($var(allowed) == 0) {
			xlog("L_NOTICE", "call $ci: $avp(caller) to $avp(callee) refused ($avp(num_class), not allowed on the trunk)\n");
			append_to_reply("Twake-Call-Refused: $avp(num_class)\r\n");
			t_reply(403, "Destination Not Allowed");
			exit;
		}
		# Step 6b (ADR 0017): the volume thresholds (in memory), the calls in progress counted, then the caller's
		# rights and the caps, read in a query of their own (route[outbound_loaded] goes on).
		route(outbound_fraud);
		route(outbound_count);
		route(outbound_query);
		exit;
	}
	# An emergency call: nothing more is read or asked (rights, caps, thresholds), it goes. The administrators hear of
	# it (E_TWAKEPHONE_EMERGENCY: the Gateway raises an alert when they come in a row), never to refuse it.
	route(emergency_event);
	route(trunk_out_send);
}

# The call goes to the operator: its trunk's first server up, the headers and the From as the operator takes them, the
# media through rtpengine, the longest it may last.
route[trunk_out_send] {
	# The operator's first server up (failover to the next ones: failure_route[trunk_failed]); for an emergency call,
	# the default trunk's when none of this one's is up.
	if (!ds_select_dst($avp(t_setid), 8, "f")) {
		xlog("L_WARN", "call $ci: no server of the trunk is up\n");
		if ($avp(num_class) != "emergency") {
			# A missed call (the minutes allotted to it are released with it).
			route(account_missed);
			append_to_reply("Twake-Call-Refused: no-trunk\r\n");
			t_reply(503, "Trunk Unavailable");
			exit;
		}
		if (!route(default_trunk) || !ds_select_dst($avp(t_setid), 8, "f")) {
			route(emergency_failed, "no server up");
			exit;
		}
	}
	route(trunk_target);
	# Only what a call needs goes to the operator (route[trunk_headers]), a Contact without the extension
	# (route[trunk_contact]); who calls, for it: the number presented, never a name of the directory nor the extension;
	# whom: the number as it writes them, at its domain (not what the caller dialled, nor our address), both written
	# for each branch (branch_route[trunk_out]).
	route(trunk_headers);
	route(trunk_contact, $avp(t_contact));
	t_on_branch("trunk_out");
	# An emergency call lasts until a party hangs up (no OPTIONS to the phone, above): never cut at TRUNK_MAX_CALL_SEC.
	# A day bounds what the dialog module keeps of one both sides forgot (second review 6b, n°10; restored by a
	# restart, 2 h more at most). Any other one ends when its time is up ($avp(o_max_sec),
	# route[outbound_loaded]: TRUNK_MAX_CALL_SEC, its share of the minutes left, the critical duration of its number).
	if ($avp(num_class) == "emergency")
		$DLG_timeout = 86400;
	else if ($avp(o_max_sec) != NULL && $avp(o_max_sec) > 0)
		$DLG_timeout = $avp(o_max_sec);
	else
		$DLG_timeout = ${TRUNK_MAX_CALL_SEC};
	# A room's call (step 8): MEET_MAX_CALL_SEC at most. Its OPTIONS (P) reach LiveKit SIP, which answers any: a
	# LiveKit SIP gone in the middle of the call is not noticed before that.
	if ($dlg_val(meet) == "caller" && $DLG_timeout > $shv(meet_max_sec))
		$DLG_timeout = $shv(meet_max_sec);
	$(avp(t_rang)[*]) = NULL;
	$dlg_val(trunk) = "callee";
	$dlg_val(codecs) = $avp(t_codecs);
	$dlg_val(callee) = $avp(callee);
	$dlg_val(dialled) = $avp(dialled);
	# A call without SDP (a SIP phone's late offer): the operator's offer in its 2xx, through rtpengine, to the phone (or
	# LiveKit SIP), whose answer in the ACK goes through it too (route[rtp_late_offer]), never the operator's own SDP.
	if (has_body_part("application/sdp"))
		route(rtp_offer);
	else
		route(late_offer);
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

# The calls to the public network in progress (step 6b, ADR 0017), this one counted in: the caller's (dialog profile
# trunk_caller) and everyone's (trunk_out), under a lock, so that of two calls at once one counts the other (never both
# refused, never both let through by a cap of one). Never an emergency call.
route[outbound_count] {
	get_static_lock("outbound_count");
	set_dlg_profile("trunk_caller", "$avp(caller)");
	set_dlg_profile("trunk_out");
	get_profile_size("trunk_caller", "$avp(caller)", $var(u_active));
	get_profile_size("trunk_out", , $var(t_active));
	release_static_lock("outbound_count");
}

# The caller's rights and the caps (twake_outbound() of outbound.ts): the class of the number in their profile, the
# calls at the same time, the answered calls and minutes of the day and month (`outbound_usage`, kept as the CDRs are
# written: no CDR is read here), and how long the call may last, its share of the minutes left reserved for it. On
# connections of their own (OPENSIPS_RULES_DB_URL, bounded by RULES_QUERY_TIMEOUT_MS). The number without its + (the
# thresholds' prefixes), "33" for one that is not E.164 (116xxx, as dialled); the Call-ID as its md5.
route[outbound_query] {
	$var(o_ext) = "";
	if ($avp(caller) =~ "^[A-Za-z0-9._+-]{1,64}$")
		$var(o_ext) = $avp(caller);
	$var(o_class) = "";
	if ($avp(num_class) =~ "^[a-z-]{1,32}$")
		$var(o_class) = $avp(num_class);
	$var(o_number) = "33";
	if ($avp(callee) =~ "^\+[0-9]{2,15}$")
		$var(o_number) = $(avp(callee){s.substr,1,0});
	$var(o_key) = $(ci{s.md5});
	$var(outbound_query) = "SELECT verdict, reason, reason_scope, max_sec FROM twake_outbound('" + $var(o_ext) + "', '" + $var(o_class) + "', '" + $var(o_number) + "', " + $var(u_active) + ", " + $var(t_active) + ", '" + $var(o_key) + "', ${TRUNK_MAX_CALL_SEC}, ${TRUNK_MIN_CALL_SEC})";
	$(avp(o_verdict)[*]) = NULL;
	$(avp(o_reason)[*]) = NULL;
	$(avp(o_scope)[*]) = NULL;
	$(avp(o_max_sec)[*]) = NULL;
	async(sql_query_one("$var(outbound_query)", "$avp(o_verdict);$avp(o_reason);$avp(o_scope);$avp(o_max_sec)"), outbound_loaded);
}

# What twake_outbound() said: a number outside the caller's rights (route[outbound_rights]), a cap reached
# (route[outbound_limit]), or the longest the call may last. Not read (a timeout, the database down): refused, with its
# own reason (Twake-Call-Refused: policy-unavailable), never let through unchecked; an emergency call never comes here.
route[outbound_loaded] {
	$var(outbound_rc) = $rc;
	if (t_was_cancelled()) {
		route(account_missed);
		t_reply(487, "Request Terminated");
		exit;
	}
	if ($var(outbound_rc) < 0 || $avp(o_verdict) == NULL) {
		xlog("L_WARN", "call $ci: the rules of the calls to the public network not read ($var(outbound_rc)): refused\n");
		# twake_outbound() may have run all the same (OpenSIPS past db_max_async_connections runs it, then drops what
		# it said): what it reserved for this call goes, or it would count against the caller's minutes for nothing.
		$var(o_key) = $(ci{s.md5});
		sql_query("DELETE FROM outbound_reservations WHERE call_key = '$var(o_key)'");
		append_to_reply("Twake-Call-Refused: policy-unavailable\r\n");
		t_reply(503, "Call Rules Unavailable");
		exit;
	}
	if ($avp(o_verdict) == "rights")
		route(outbound_rights);
	if ($avp(o_verdict) == "limit")
		route(outbound_limit, $avp(o_reason), $avp(o_scope));
	if ($avp(o_verdict) != "ok") {
		append_to_reply("Twake-Call-Refused: policy-unavailable\r\n");
		t_reply(503, "Call Rules Unavailable");
		exit;
	}
	route(trunk_out_send);
}

# A number outside the caller's rights (FR-H3: the class of the number is not in their profile; without a profile,
# the trunk's alone): refused (Twake-Call-Refused: rights), and the Gateway hears it for the administrators
# (E_TWAKEPHONE_RIGHTS): a person who may call inside only, dialling abroad, is how a stolen account shows.
route[outbound_rights] {
	xlog("L_NOTICE", "call $ci: $avp(caller) to $avp(callee) refused ($avp(num_class), not in the caller's rights)\n");
	$(avp(ev_attr)[*]) = NULL;
	$(avp(ev_val)[*]) = NULL;
	$avp(ev_attr) = "caller";
	$avp(ev_val) = $avp(caller);
	$avp(ev_attr) = "number";
	$avp(ev_val) = $avp(callee);
	$avp(ev_attr) = "param";
	$avp(ev_val) = $avp(num_class);
	$avp(ev_attr) = "callid";
	$avp(ev_val) = $ci;
	raise_event("E_TWAKEPHONE_RIGHTS", $avp(ev_attr), $avp(ev_val));
	append_to_reply("Twake-Call-Refused: rights\r\n");
	t_reply(403, "Destination Not Allowed");
	exit;
}

# An emergency call, told to the Gateway (E_TWAKEPHONE_EMERGENCY): it raises an alert when they come in a row from one
# extension. Nothing is refused for it.
route[emergency_event] {
	$(avp(ev_attr)[*]) = NULL;
	$(avp(ev_val)[*]) = NULL;
	$avp(ev_attr) = "caller";
	$avp(ev_val) = $avp(caller);
	$avp(ev_attr) = "number";
	$avp(ev_val) = $avp(callee);
	$avp(ev_attr) = "callid";
	$avp(ev_val) = $ci;
	raise_event("E_TWAKEPHONE_EMERGENCY", $avp(ev_attr), $avp(ev_val));
}

# A cap reached ($param(1), of $param(2): user or tenant): the caller is told why (Twake-Call-Refused: limit), the
# Gateway hears it for the administrators (E_TWAKEPHONE_LIMIT).
route[outbound_limit] {
	xlog("L_WARN", "call $ci: $avp(caller) to $avp(callee) refused, cap $param(1) of the $param(2) reached\n");
	$(avp(ev_attr)[*]) = NULL;
	$(avp(ev_val)[*]) = NULL;
	$avp(ev_attr) = "caller";
	$avp(ev_val) = $avp(caller);
	$avp(ev_attr) = "number";
	$avp(ev_val) = $avp(callee);
	$avp(ev_attr) = "param";
	$avp(ev_val) = $param(1);
	$avp(ev_attr) = "scope";
	$avp(ev_val) = $param(2);
	$avp(ev_attr) = "callid";
	$avp(ev_val) = $ci;
	raise_event("E_TWAKEPHONE_LIMIT", $avp(ev_attr), $avp(ev_val));
	append_to_reply("Twake-Call-Refused: limit\r\n");
	t_reply(403, "Limit Reached");
	exit;
}

# The volume thresholds (step 6b, fraud_detection): the caller's calls to this number's rule (+33, or any other),
# the number without its +. Past a critical threshold, refused (Twake-Call-Refused: fraud); past a warning one, the
# call goes on. The module raises the events itself. A number that is not E.164 (116xxx, as dialled) is not counted.
route[outbound_fraud] {
	if (!($avp(callee) =~ "^\+[0-9]{2,15}$"))
		return(1);
	$var(fraud_number) = $(avp(callee){s.substr,1,0});
	check_fraud("$avp(caller)", "$var(fraud_number)", 1);
	$var(fraud_rc) = $rc;
	if ($var(fraud_rc) == -2) {
		xlog("L_WARN", "call $ci: $avp(caller) to $avp(callee) refused, critical volume threshold crossed\n");
		append_to_reply("Twake-Call-Refused: fraud\r\n");
		t_reply(403, "Volume Threshold Reached");
		exit;
	}
	if ($var(fraud_rc) == -3)
		xlog("L_ERR", "call $ci: volume thresholds not checked (fraud_detection failed)\n");
	return(1);
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

# A request to the operator says once what it is: one From, To, Call-ID and CSeq, at most one Max-Forwards,
# Content-Type and Content-Length, compact forms counted (a second From would reach the operator as the phone wrote
# it: uac_replace_from rewrites the first). Its body, if any, is SDP only: a multipart one could carry an ISUP part
# (SIP-I: calling and charged numbers) the operator would read. -1 otherwise, with the answer in $var(refuse_code) and
# $var(refuse_reason) (400, 415).
route[trunk_request] {
	if ($hdrcnt(From) != 1 || $hdrcnt(To) != 1 || $hdrcnt(Call-ID) != 1 || $hdrcnt(CSeq) != 1 || $hdrcnt(Max-Forwards) > 1 || $hdrcnt(Content-Type) > 1 || $hdrcnt(Content-Length) > 1) {
		$var(refuse_code) = 400;
		$var(refuse_reason) = "Duplicate Header";
		return(-1);
	}
	if ($rb != NULL && $(rb{s.len}) > 0 && !($(hdr(Content-Type){s.tolower}) =~ "^application/sdp[[:space:]]*(;.*)?$")) {
		$var(refuse_code) = 415;
		$var(refuse_reason) = "Unsupported Media Type";
		return(-1);
	}
	return(1);
}

# The Contact a phone gives, to the operator: one, its address as fix_nated_contact made it ($param(1) when read
# earlier), without its user part (a desk phone's extension, a browser's token) nor the parameters of the header
# (+sip.instance...). The operator's requests in the call come back through our Record-Route, and fix_route_dialog
# takes them to the phone's own Contact (main route).
route[trunk_contact] {
	if (!is_present_hf("Contact"))
		return(1);
	$var(ct) = $param(1);
	if ($var(ct) == NULL || $var(ct) == "")
		$var(ct) = $(ct.fields(uri){re.subst,/^(sips?):[^@;]*@/\1:/});
	remove_hf("Contact");
	if ($var(ct) != NULL && $var(ct) != "")
		append_hf("Contact: <$var(ct)>\r\n");
}

# The call as the trunk in hand ($avp(t_*)) wants it: the number called and the number presented written its way (a
# short one, 112, 15, 116006..., as dialled), at its domain, from the trunk socket. $avp(t_ruri) keeps the
# Request-URI for failure_route[trunk_failed], which starts again from the one the call came with.
route[trunk_target] {
	$socket_out = "udp:${TRUNK_LISTEN_IP}:${TRUNK_PORT}";
	$var(to_user) = $avp(callee);
	if ($avp(callee) =~ "^\+") {
		route(trunk_number, $avp(callee));
		$var(to_user) = $var(trunk_number);
	}
	route(trunk_number, $avp(t_presented));
	$(avp(t_from_user)[*]) = NULL;
	$avp(t_from_user) = $var(trunk_number);
	$(avp(t_to_user)[*]) = NULL;
	$avp(t_to_user) = $var(to_user);
	$ru = "sip:" + $var(to_user) + "@" + $avp(t_domain);
	$(avp(t_ruri)[*]) = NULL;
	$avp(t_ruri) = $ru;
}

# Each INVITE to the operator, from the trunk it goes to (route[trunk_target]; another one for an emergency call that
# failed on its own, failure_route[trunk_failed]): From and To its way, and the P-Asserted-Identity it may want.
branch_route[trunk_out] {
	uac_replace_from("", "sip:$avp(t_from_user)@$avp(t_domain)");
	uac_replace_to("", "sip:$avp(t_to_user)@$avp(t_domain)");
	if ($avp(t_pai) == 1)
		append_hf("P-Asserted-Identity: <sip:$avp(t_from_user)@$avp(t_domain)>\r\n");
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
# redirection (3xx) is not followed and its Contact never reaches the phone: 480. An emergency call its trunk does not
# put through goes once more through the default trunk (route[emergency_fallback]); one that does not go through at
# all tells the caller to call from another phone (route[emergency_failed]). A call that does not go through is
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
				t_on_branch("trunk_out");
				t_on_reply("rtp");
				t_on_failure("trunk_failed");
				if (t_relay())
					exit;
			}
		}
		xlog("L_WARN", "call $ci: the operator's challenge ($T_reply_code) could not be answered: check the trunk's login, password and realm\n");
		if (route(emergency_fallback))
			exit;
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
		t_on_branch("trunk_out");
		t_on_reply("rtp");
		t_on_failure("trunk_failed");
		if (t_relay())
			exit;
	}
	if (route(emergency_fallback))
		exit;
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

# An emergency call its trunk did not put through, whatever the reason (refused, failed, a challenge it could not
# answer; its other servers tried as for any call): once more, through the default trunk (route[default_trunk]: none
# when that is the trunk tried, or this process never read one), from its first server up, with its own number and
# credentials. The offer made to the first trunk stays (its codecs). 1 when sent.
route[emergency_fallback] {
	if ($avp(num_class) != "emergency" || $avp(t_fallback) != NULL)
		return(-1);
	$avp(t_fallback) = 1;
	$var(failed) = "" + $T_reply_code;
	if (!route(default_trunk) || !ds_select_dst($avp(t_setid), 8, "f"))
		return(-1);
	xlog("L_WARN", "call $ci: emergency call failed on its trunk ($var(failed)), through the default trunk\n");
	route(trunk_target);
	$dlg_val(codecs) = $avp(t_codecs);
	$(avp(t_challenged)[*]) = NULL;
	$(avp(t_rang)[*]) = NULL;
	t_on_branch("trunk_out");
	t_on_reply("rtp");
	t_on_failure("trunk_failed");
	if (t_relay())
		return(1);
	return(-1);
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
	remove_hf("Twake-Room");
	remove_hf("Twake-Join");
	remove_hf("Twake-Conference");
	remove_hf("X-Twake-Mailbox");
	remove_hf("X-Twake-Voicemail");
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
	# The phone's answers go to the operator: their Contact without the extension (onreply_route[rtp]).
	$avp(reply_to_trunk) = 1;
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
	# With the number's target: its fallback (step 6b, the direct number's own, else its trunk's), what it is (an
	# extension not in "do not disturb", else a ring group, else nothing), the members of the group not in "do not
	# disturb" (in their order, separated by |), and whether the target is anyone's (an account or a group: a number
	# of a range nobody holds is not found, 404, and has no fallback).
	$var(dnd_sql) = "SELECT 1 FROM call_rules r WHERE r.extension = ";
	$var(dnd_now) = " AND r.dnd AND (r.dnd_until IS NULL OR r.dnd_until > now())";
	$var(did_query) = "SELECT x.target, x.codecs, x.fb, CASE WHEN EXISTS (SELECT 1 FROM subscriber s WHERE s.username = x.fb) THEN CASE WHEN EXISTS (" + $var(dnd_sql) + "x.fb" + $var(dnd_now) + ") THEN '' ELSE 'extension' END WHEN EXISTS (SELECT 1 FROM call_groups g WHERE g.number = x.fb) THEN 'group' ELSE '' END, coalesce((SELECT string_agg(m.ext, '|' ORDER BY m.pos) FROM call_groups g CROSS JOIN LATERAL unnest(g.members) WITH ORDINALITY AS m(ext, pos) WHERE g.number = x.fb AND m.ext ~ '^[A-Za-z0-9._+-]{1,64}$' AND NOT EXISTS (" + $var(dnd_sql) + "m.ext" + $var(dnd_now) + ")), ''), CASE WHEN EXISTS (SELECT 1 FROM subscriber s WHERE s.username = x.target) OR EXISTS (SELECT 1 FROM call_groups g WHERE g.number = x.target) THEN 1 ELSE 0 END FROM (SELECT CASE WHEN d.suffix_digits > 0 THEN right(n.num, d.suffix_digits) ELSE d.target END AS target, t.codec_flags AS codecs, coalesce(nullif(d.fallback, ''), t.fallback) AS fb FROM (VALUES (CASE WHEN EXISTS (SELECT 1 FROM trunks b WHERE b.reg_aor <> '' AND b.auth_username = '" + $var(ru_user) + "') THEN 3 ELSE 1 END, '" + $var(n1) + "'), (2, '" + $var(n2) + "')) AS n(o, num) JOIN dids d ON length(d.first_number) = length(n.num) AND n.num BETWEEN d.first_number AND d.last_number JOIN trunks t ON t.id = d.trunk_id ORDER BY n.o, d.suffix_digits LIMIT 1) x";
	$avp(did_query) = $var(did_query);
	route(read_sent);
	async(sql_query_one("$var(did_query)", "$avp(did_target);$avp(t_codecs);$avp(fb_target);$avp(fb_kind);$avp(fb_members);$avp(did_assigned)"), trunk_in_loaded);
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
	if ($var(did_rc) == -1 && route(read_again)) {
		sql_query_one("$avp(did_query)", "$avp(did_target);$avp(t_codecs);$avp(fb_target);$avp(fb_kind);$avp(fb_members);$avp(did_assigned)");
		$var(did_rc) = $rc;
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
	if ($shv(meet_on) == 1 && $avp(did_target) == "${MEET_NUMBER}") {
		route(meet_call);
		exit;
	}
	route(rules_next);
	exit;
}

# The fallback (step 6b, FR-C8, ADR 0017) of a call from the operator to one of our direct numbers that does not go
# through: nobody answers (408, the ringing lasted the no-answer delay), everyone is busy (486), nothing can be reached
# (480, 477, 5xx, no window), a group nobody of which answered. Never after a decline (603, 600, a group every phone of
# which declined), a "do not disturb" (the callee's choice), a CANCEL, nor for a number of a range nobody holds (404).
# The extension or group of the direct number's `fallback`, else its trunk's ($avp(fb_*), read with it): an extension
# in "do not disturb" is none, a group rings its members not in "do not disturb" (none woken). The fallback rings once,
# with no rules of its own (no forward from it), where the call has not been already (route[forward_to]); its own
# failure is the caller's. Rung inside, it is counted, accounted and bounded as any call: no number outside is ever
# called for it (the operator's own forward, set at the operator, is for when nothing reaches us). Ends the script
# when it rings ($param(1) why, for the log; $param(2) the status that made the call leave); -1 otherwise.
route[did_fallback] {
	if ($dlg_val(trunk) != "caller" || $avp(fb_used) != NULL || $avp(did_assigned) != 1 || $avp(fb_kind) == NULL || $avp(fb_kind) == "" || t_was_cancelled())
		return(-1);
	if ($avp(fb_target) == NULL || !($avp(fb_target) =~ "^[A-Za-z0-9._+-]{1,64}$"))
		return(-1);
	$avp(fb_used) = 1;
	$var(fb_from) = $avp(callee);
	$var(fb_group) = $avp(group);
	if (!route(forward_to, $avp(fb_target)))
		return(-1);
	xlog("L_NOTICE", "call $ci: from the operator to $var(fb_from), not through ($param(1)): to its fallback $avp(fb_target)\n");
	# Nobody's rules apply, nothing is woken: the fallback rings as it is.
	$(avp(r_always)[*]) = NULL;
	$(avp(r_busy)[*]) = NULL;
	$(avp(r_noanswer)[*]) = NULL;
	$(avp(r_dnd)[*]) = NULL;
	$(avp(r_name)[*]) = NULL;
	$(avp(wake)[*]) = NULL;
	$(avp(ringing)[*]) = NULL;
	$(avp(ring_at)[*]) = NULL;
	$(avp(group)[*]) = NULL;
	$(avp(g_ext)[*]) = NULL;
	$(avp(g_name)[*]) = NULL;
	$(avp(g_wake)[*]) = NULL;
	$(avp(g_declines)[*]) = NULL;
	$(avp(g_windows)[*]) = NULL;
	$(avp(g_woken)[*]) = NULL;
	$(avp(gw_ext)[*]) = NULL;
	$(avp(gd_ext)[*]) = NULL;
	$var(relay_request) = 0;
	if ($avp(fb_kind) == "group") {
		# Its members as route[group_next] would read them, none to wake (no transaction is held from here), but those
		# the call has rung already (the number's target, the forwards it took: second review 6b, n°9).
		$var(i) = 0;
		$var(more) = 1;
		while ($var(more) == 1 && $var(i) < 32) {
			$var(member) = $(avp(fb_members){s.select,$var(i),|});
			if ($var(member) == NULL || $var(member) == "") {
				$var(more) = 0;
			} else {
				$var(mark) = "," + $var(member) + ",";
				if ($(avp(fwd_seen){s.index,$var(mark)}) == NULL) {
					$avp(g_ext) = $var(member);
					$avp(g_name) = "";
					$avp(g_wake) = 0;
				}
			}
			$var(i) = $var(i) + 1;
		}
		route(group_place);
		if ($var(windows) == 0) {
			xlog("L_NOTICE", "call $ci: nobody of the fallback group $avp(fb_target) to ring\n");
			route(did_fallback_undo);
			return(-1);
		}
		route(group_order);
	} else if (!lookup("location")) {
		# An extension: its windows ring.
		xlog("L_NOTICE", "call $ci: the fallback $avp(fb_target) has no window\n");
		route(did_fallback_undo);
		return(-1);
	}
	$dlg_val(callee) = $avp(callee);
	route(forwarded, $var(fb_from), $param(2));
	# The offer made for the first ringing goes on (route[did_fallback_request] makes one when nothing rang yet).
	t_on_reply("rtp");
	t_on_failure("call_failed");
	t_on_branch("tried");
	route(arm_failure);
	route(relay_call);
	exit;
}

# The fallback rang nobody: the call is back where it was, for its failure.
route[did_fallback_undo] {
	$(avp(callee)[*]) = NULL;
	$avp(callee) = $var(fb_from);
	$acc_extra(callee) = $var(fb_from);
	$(avp(group)[*]) = NULL;
	if ($var(fb_group) != NULL)
		$avp(group) = $var(fb_group);
}

# From the request route, where nothing may have rung yet: the media offer the fallback's windows need, made only
# when there is a fallback to ring, then route[did_fallback].
route[did_fallback_request] {
	if ($dlg_val(trunk) != "caller" || $avp(fb_used) != NULL || $avp(did_assigned) != 1 || $avp(fb_kind) == NULL || $avp(fb_kind) == "")
		return(-1);
	if ($avp(rtp_on) == NULL && has_body_part("application/sdp"))
		route(rtp_offer);
	route(did_fallback, $param(1), $param(2));
	return(-1);
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
	if (!($hdr(From) =~ "<"))
		return(-1);
	# A room's call (step 8): the callee knows a room calls, at whose name ("Meet (Alice Martin)"; "Meet" alone when
	# the names cannot be read), not the person's phone.
	if ($dlg_val(meet) == "caller") {
		$var(caller_name) = "Meet";
		if ($avp(names_read) == 1 && $avp(n_caller) != NULL && $avp(n_caller) != "")
			$var(caller_name) = "Meet (" + $avp(n_caller) + ")";
		# A conference's call (step 8b): the person who made it, as the directory names them (the app says the rest).
		if ($avp(conference) != NULL) {
			$var(caller_name) = "";
			if ($avp(names_read) == 1 && $avp(n_caller) != NULL)
				$var(caller_name) = $avp(n_caller);
		}
		uac_replace_from("$var(caller_name)", "");
		return(1);
	}
	if ($avp(names_read) != 1)
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

# A read the call cannot go without (route[trunk_in], route[trunk_out]) that failed (-1): 1 to make it again, once,
# synchronously. Past db_max_async_connections in this process, OpenSIPS 3.6 ran it but dropped its row (a burst of
# calls from the operator: the direct number of one of them not found, 404); a database that fails it costs one
# RULES_QUERY_TIMEOUT_MS more. Only for a SELECT: what it reads, it does not change.
# When an asynchronous read went (route[read_sent]): milliseconds, modulo 1000 s (an OpenSIPS integer has 32 bits).
route[read_sent] {
	$avp(q_sent) = ($Ts % 1000) * 1000 + ($Tsm / 1000);
}

# A read that failed (-1) is made again, synchronously, when it failed at once: OpenSIPS past db_max_async_connections
# (or a connection refused). One that failed after half of RULES_QUERY_TIMEOUT_MS or more is a slow database: not made
# again, never holding this process twice as long.
route[read_again] {
	if ($avp(q_sent) == NULL) {
		xlog("L_WARN", "call $ci: a read failed, when it went unknown: not made again\n");
		return(-1);
	}
	$var(q_now) = ($Ts % 1000) * 1000 + ($Tsm / 1000);
	$var(q_spent) = ($var(q_now) - $avp(q_sent) + 1000000) % 1000000;
	$var(q_twice) = $var(q_spent) * 2;
	if ($var(q_twice) >= ${RULES_QUERY_TIMEOUT_MS}) {
		xlog("L_WARN", "call $ci: a read failed after $var(q_spent) ms: not made again\n");
		return(-1);
	}
	xlog("L_NOTICE", "call $ci: a read failed at once (-1, past db_max_async_connections or the database): made again\n");
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
	# `voicemail_boxes` (step 11a) likewise: when the database says it is missing, no call goes to a mailbox for 30 s, and
	# the read goes again without it.
	if ($avp(q11) == 1 && route(table_11_missing)) {
		$shv(no11_until) = $Ts + 30;
		xlog("L_WARN", "call $ci: the database has no voicemail_boxes (the Gateway of step 11a creates it): no mailbox for 30 s\n");
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

# Whether the database says `voicemail_boxes` is missing (as route[tables_4c_missing]).
route[table_11_missing] {
	$var(missing) = 0;
	if (!sql_query_one("SELECT CASE WHEN to_regclass('voicemail_boxes') IS NULL THEN 1 ELSE 0 END", "$var(missing)"))
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
	route(group_place);
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
		route(calling);
		route(did_fallback_request, "nobody of the group", "480");
		if ($avp(rtp_on) != NULL)
			rtpengine_delete();
		route(account_missed);
		t_reply(480, "Temporarily Unavailable");
		exit;
	}
	route(group_order);
	route(ring);
}

# The windows of the members of group $rU in the $avp(w_*) lists ($var(windows) of them), and the members without a
# window to wake ($var(woken), $avp(gw_ext)); from the request route or failure_route (a direct number's fallback).
route[group_place] {
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
}

# The windows collected by route[group_place] onto the Request-URI and the branches, up to $var(cap).
route[group_order] {
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
	if ($dlg_val(trunk) != NULL || $dlg_val(meet) != NULL)
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
		# The mailbox of the extension dialled (step 11a, route[voicemail]): only while Wazo is on and the database has
		# its table (route[read_failed]). Only the characters of a mailbox's address (`number@context`) are kept.
		$(avp(q11)[*]) = NULL;
		$(avp(vm_box)[*]) = NULL;
		$var(vm_col) = ", NULL";
		if ($shv(wazo_on) == 1 && $shv(no11_until) <= $Ts) {
			$avp(q11) = 1;
			$var(vm_col) = ", (SELECT v.mailbox FROM voicemail_boxes v WHERE v.extension = '" + $rU + "' AND v.mailbox ~ '^[0-9]{1,40}@[A-Za-z0-9_-]{1,79}$')";
		}
		$var(rules_query) = "SELECT " + $var(rules_cols) + $var(first_cols) + $var(vm_col) + $var(rules_from);
		async(sql_query_one("$var(rules_query)", "$avp(r_always);$avp(r_busy);$avp(r_noanswer);$avp(r_delay);$avp(r_dnd);$avp(r_message);$avp(r_retry);$avp(r_name);$avp(n_caller);$avp(r_group);$avp(vm_box)"), rules_loaded);
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
	$(avp(q11)[*]) = NULL;
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
	route(calling);
	# A call from the operator: the fallback of its direct number (route[did_fallback]).
	route(did_fallback_request, "unreachable", "480");
	$avp(vm_code) = 480;
	$avp(vm_reason) = "Temporarily Unavailable";
	if ($avp(fwd_hops) == 0 && $avp(dialled_unread) != 1) {
		$avp(vm_code) = 404;
		$avp(vm_reason) = "Not Found";
	}
	# The mailbox of the extension dialled (step 11a): nobody can answer now.
	$avp(vm_then) = "reply";
	route(voicemail, "unavailable");
	# The offer made before looking for a browser to wake (route[wake_next]) is over.
	if ($avp(rtp_on) != NULL)
		rtpengine_delete();
	route(account_missed);
	t_reply($avp(vm_code), "$avp(vm_reason)");
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
	# The mailbox of the extension dialled takes the call instead (step 11a), the caller hears its greeting; the
	# refusal waits for when it does not answer (failure_route[voicemail_failed] comes back here).
	if ($avp(vm_used) == NULL && $avp(vm_box) != NULL) {
		$avp(vm_then) = "dnd";
		$avp(vm_who) = $var(dnd_who);
		$avp(vm_told) = $var(dnd_told);
		$avp(vm_message) = $var(dnd_message);
		$avp(vm_retry) = $var(dnd_retry);
		$avp(vm_dnd_code) = $var(dnd_code);
		$avp(vm_code) = 480;
		route(voicemail, "unavailable");
	}
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
	if ($var(relay_rc) == -6)
		route(did_fallback, "not sent", "477");
	else
		route(did_fallback, "not sent", "500");
	$avp(vm_code) = 500;
	$avp(vm_reason) = "Internal Error";
	if ($var(relay_rc) == -6) {
		$avp(vm_code) = 477;
		$avp(vm_reason) = "Send failed";
	}
	# The mailbox of the extension dialled (step 11a): none of the windows could be reached.
	$avp(vm_then) = "reply";
	route(voicemail, "unavailable");
	if ($avp(rtp_on) != NULL)
		rtpengine_delete();
	route(account_missed);
	t_reply($avp(vm_code), "$avp(vm_reason)");
	exit;
}

#### Voicemail (step 11a, ADR 0022) ####################################################################################
# A call nothing else takes goes to the mailbox of the extension dialled ($avp(dialled), whatever forward the call
# followed), read with its rules ($avp(vm_box), route[rules_next]), on Wazo's Asterisk (WAZO_SIP), from Wazo's socket:
# a "do not disturb" (route[dnd_reply]), nobody to ring (route[unreachable]), no window reached (route[relay_failed]),
# busy, declined or no answer (the failure route of a call), each after the forwards and the fallback of a direct
# number. Never for a ring group, a room's call (Meet) or a conference's, an INVITE with Replaces, a call to oneself
# or one the caller cancelled. The INVITE carries the mailbox and the greeting (X-Twake-Mailbox, X-Twake-Voicemail:
# busy or unavailable), which only this script writes, and the offer rtpengine made for the callee's windows (Asterisk
# takes it as a browser would: ICE, DTLS-SRTP). For the caller the mailbox answered (E_TWAKEPHONE_VOICEMAIL, then the
# CDR, `via` voicemail); for the extension dialled it is a missed call. A mailbox that does not answer gives the caller
# what it would have had without it (failure_route[voicemail_failed]): the same refusal, the same missed call.
# A call to a mailbox lasts VOICEMAIL_MAX_CALL_SEC at most ($DLG_timeout; a call from the operator then ends with a BYE
# both ways, B; Asterisk hangs up its side at that bound too, and records VOICEMAIL_MAX_SEC at most: review 11a, n°3).
# A mailbox that does not answer within 2 s (Wazo down, a row of voicemail_boxes out of date) is left for the refusal,
# and when nothing at all came back from Asterisk, every mailbox is left out the next 30 s (n°14). The greeting says
# whether the caller is outside (`;caller=external`): the extension is never spelled out to them (n°12). Bounded as
# Meet's access number is (second review 11a, n°10): VOICEMAIL_CALLS_PER_CALLER calls of one caller to the mailboxes
# at the same time (those who hide their number together, under VOICEMAIL_CALLS_ALL), VOICEMAIL_CALLS_ALL of all
# callers, and VOICEMAIL_CALLS_PER_HOUR calls of one caller to the same mailbox in an hour (one caller filling a
# mailbox fills it for everyone); past one, the refusal the call would have had without the mailbox.
# $param(1): the greeting; $avp(vm_then), $avp(vm_code), $avp(vm_reason): that refusal. Ends the script when the
# mailbox is called; -1 otherwise.
route[voicemail] {
	if ($shv(wazo_on) != 1 || $shv(wazo_mute_until) > $Ts || $avp(vm_box) == NULL || $avp(vm_used) != NULL || $avp(group) != NULL || $dlg_val(meet) != NULL || $avp(conference) != NULL)
		return(-1);
	if (is_present_hf("Replaces") || t_was_cancelled() || $avp(dialled) == $avp(caller) || !($avp(dialled) =~ "^[0-9]{1,40}$"))
		return(-1);
	if ($avp(rtp_on) == NULL && !has_body_part("application/sdp"))
		return(-1);
	$avp(vm_used) = 1;
	$var(vm_who) = "other";
	if ($avp(caller) =~ "^[A-Za-z0-9._+-]{1,64}$")
		$var(vm_who) = $avp(caller);
	$var(vm_cap) = ${VOICEMAIL_CALLS_PER_CALLER};
	if ($var(vm_who) == "anonymous" || $var(vm_who) == "other") {
		$var(vm_cap) = ${VOICEMAIL_CALLS_ALL};
	} else {
		$var(vm_n) = 0;
		cache_add("local", "vm:h:$var(vm_who):$avp(dialled)", 1, 3600, $var(vm_n));
		if ($var(vm_n) > ${VOICEMAIL_CALLS_PER_HOUR}) {
			xlog("L_NOTICE", "call $ci: the mailbox of $avp(dialled) left out, $var(vm_n) calls of this caller to it in an hour\n");
			return(-1);
		}
	}
	# The calls to the mailboxes at the same time, this one counted in only if there is room, under a lock: of two calls
	# at once, one counts the other. Its dialog leaves the profiles when it ends.
	$var(vm_room) = 0;
	get_static_lock("vm_count");
	get_profile_size("vm_caller", "$var(vm_who)", $var(vm_mine));
	get_profile_size("vm_all", , $var(vm_all));
	if ($var(vm_mine) < $var(vm_cap) && $var(vm_all) < ${VOICEMAIL_CALLS_ALL}) {
		set_dlg_profile("vm_caller", "$var(vm_who)");
		set_dlg_profile("vm_all");
		$var(vm_room) = 1;
	}
	release_static_lock("vm_count");
	if ($var(vm_room) == 0) {
		xlog("L_WARN", "call $ci: the mailbox of $avp(dialled) left out, $var(vm_mine) calls of this caller and $var(vm_all) of all callers to the mailboxes at the same time\n");
		return(-1);
	}
	# The offer the windows would have had (a refusal before any of them rang has none yet: only in the request route,
	# the initial INVITE, from the caller to a browser-like callee). Not route[rtp_offer]: it asks the dialog for the
	# direction (route[sides]), which a failure route cannot, and answers 503 itself; here the caller gets the original
	# refusal instead.
	if ($avp(rtp_on) == NULL) {
		$var(from_kind) = 0;
		if ($dlg_val(trunk) == "caller")
			$var(from_kind) = 1;
		$(avp(offer_from)[*]) = NULL;
		$avp(offer_from) = $var(from_kind);
		route(rtp_flags, 0);
		if (!rtpengine_offer("$var(rtp_flags)")) {
			xlog("L_ERR", "call $ci: rtpengine offer for the mailbox of $avp(dialled) failed\n");
			return(-1);
		}
		$avp(rtp_on) = 1;
	}
	$(avp(vm_from)[*]) = NULL;
	$avp(vm_from) = $avp(callee);
	# How the call went until now, given back if the mailbox does not answer (route[voicemail_undo]).
	$(avp(vm_via)[*]) = NULL;
	if ($acc_extra(via) != NULL)
		$avp(vm_via) = $acc_extra(via);
	$(avp(vm_timeout)[*]) = NULL;
	$avp(vm_timeout) = $DLG_timeout;
	$(avp(callee)[*]) = NULL;
	$avp(callee) = $avp(dialled);
	$acc_extra(callee) = $avp(dialled);
	$acc_extra(via) = "voicemail";
	$dlg_val(callee) = $avp(dialled);
	$dlg_val(voicemail) = "1";
	$(avp(voicemail)[*]) = NULL;
	$avp(voicemail) = $param(1);
	$ru = "sip:" + $avp(dialled) + "@${WAZO_SIP}";
	$du = NULL;
	$socket_out = "udp:${WAZO_LISTEN_IP}:${WAZO_PORT}";
	remove_hf("X-Twake-Mailbox");
	remove_hf("X-Twake-Voicemail");
	append_hf("X-Twake-Mailbox: $avp(vm_box)\r\n");
	if ($dlg_val(trunk) == "caller")
		append_hf("X-Twake-Voicemail: $param(1);caller=external\r\n");
	else
		append_hf("X-Twake-Voicemail: $param(1)\r\n");
	if ($DLG_timeout == NULL || $DLG_timeout > ${VOICEMAIL_MAX_CALL_SEC})
		$DLG_timeout = ${VOICEMAIL_MAX_CALL_SEC};
	# Asterisk answers at once (100 Trying within 2 s, then its 200); the ringing delay of a forward does not apply.
	$T_fr_timeout = 2;
	$T_fr_inv_timeout = 15;
	route(calling);
	t_on_reply("rtp");
	t_on_failure("voicemail_failed");
	xlog("L_INFO", "call $ci: to the mailbox of $avp(dialled) ($param(1))\n");
	if (t_relay())
		exit;
	xlog("L_WARN", "call $ci: the mailbox of $avp(dialled) could not be called ($rc)\n");
	route(voicemail_undo);
	return(-1);
}

# The mailbox did not take the call: it is back where it was, for its refusal (its `via` and its lifetime too). The
# headers appended for Asterisk stay on the request (second review 11a, n°17): remove_hf sees the headers received
# only, never those append_hf added, and what route[voicemail] appended is not undone. No path relays the request after
# this route (each one replies, or ends): none reaches anyone else.
route[voicemail_undo] {
	$(avp(voicemail)[*]) = NULL;
	$dlg_val(voicemail) = "0";
	$(avp(callee)[*]) = NULL;
	$avp(callee) = $avp(vm_from);
	$acc_extra(callee) = $avp(vm_from);
	$acc_extra(via) = "";
	if ($avp(vm_via) != NULL)
		$acc_extra(via) = $avp(vm_via);
	if ($avp(vm_timeout) != NULL && $avp(vm_timeout) > 0)
		$DLG_timeout = $avp(vm_timeout);
	$dlg_val(callee) = $avp(vm_from);
}

failure_route[voicemail_failed] {
	$var(relay_request) = 0;
	if (t_was_cancelled()) {
		rtpengine_delete();
		route(account_missed);
		exit;
	}
	xlog("L_NOTICE", "call $ci: the mailbox of $avp(dialled) did not answer ($T_reply_code), the caller gets $avp(vm_code)\n");
	if (t_check_status("408") && t_local_replied("all")) {
		$shv(wazo_mute_until) = $Ts + 30;
		xlog("L_WARN", "Wazo's Asterisk does not answer: the mailboxes are left out 30 s\n");
	}
	route(voicemail_undo);
	# The fallback group of a direct number nobody of which answered (the failure route of a call): its refusal, the
	# group's missed call.
	if ($avp(vm_then) == "group") {
		$avp(group) = $avp(vm_group);
		rtpengine_delete();
		route(group_missed, "480 Temporarily Unavailable");
		t_reply(480, "Temporarily Unavailable");
		exit;
	}
	# A "do not disturb": its refusal as it was, with its message (route[dnd_reply], which ends the script).
	if ($avp(vm_then) == "dnd") {
		$var(dnd_who) = $avp(vm_who);
		$var(dnd_told) = $avp(vm_told);
		$var(dnd_message) = $avp(vm_message);
		$var(dnd_retry) = $avp(vm_retry);
		$var(dnd_code) = $avp(vm_dnd_code);
		route(dnd_reply);
	}
	rtpengine_delete();
	route(account_missed);
	t_reply($avp(vm_code), "$avp(vm_reason)");
	exit;
}

# Requests OpenSIPS sends of its own (tm). The dialog's OPTIONS to the phone of a call with the operator wait
# CALL_PING_TIMEOUT_SEC for an answer, not the 5 s of fr_timeout: the dialog ends the call on the first one that times
# out (408). The BYEs the dialog sends to end a call (its phone gone, TRUNK_MAX_CALL_SEC) free the call's media in
# rtpengine, once for the two of them, as a party's BYE does in the main route, and at once (delete-delay=0, not
# rtpengine's 30 s): neither party sends media any more, and its ports go back to the range.
local_route {
	if (is_method("OPTIONS") && has_totag()) {
		$T_fr_timeout = ${CALL_PING_TIMEOUT_SEC};
	} else if (is_method("BYE") && $dlg_val(rtp_freed) != "1") {
		$dlg_val(rtp_freed) = "1";
		rtpengine_delete("delete-delay=0");
	}
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
	remove_hf("Twake-Voicemail");
	remove_hf("P-Asserted-Identity");
	# The callee's Contact: same ".invalid" host, same fix (see above).
	fix_nated_contact();
	# An answer of the phone to the operator (its call, or its request in one): a Contact without the extension
	# (route[trunk_contact]); the dialog keeps the phone's own, as fix_nated_contact made it.
	if ($avp(reply_to_trunk) == 1)
		route(trunk_contact);
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
	# The mailbox answered (step 11a, route[voicemail]): told once, as itself, never as a ringing or an answer of the
	# callee; nobody's identity is asserted to the caller.
	if ($avp(voicemail) != NULL) {
		# Nothing says to the caller what answered (second review 11a, n°19): neither Asterisk's software nor that it is a
		# mailbox.
		remove_hf("Server");
		remove_hf("User-Agent");
		# The caller's window says whose mailbox it hears (review 11a, n°26): Twake-Voicemail, never to the operator.
		if ($rs >= 200 && $rs < 300 && $dlg_val(trunk) != "caller")
			append_hf("Twake-Voicemail: 1\r\n");
		if ($rs >= 200 && $rs < 300 && $avp(vm_answered) == NULL) {
			$avp(vm_answered) = 1;
			route(event_attrs);
			$avp(ev_attr) = "greeting";
			$avp(ev_val) = $avp(voicemail);
			$avp(ev_attr) = "code";
			$avp(ev_val) = $avp(vm_code);
			raise_event("E_TWAKEPHONE_VOICEMAIL", $avp(ev_attr), $avp(ev_val));
		}
		exit;
	}
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
			# The tag of the phone that answered: a room's call that takes the place of this one names it (step 8b).
			$dlg_val(callee_tag) = $tt;
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
	# A room's call of a conference (step 8b): its callee's only (route[conference_leg]).
	if ($avp(conference) != NULL) {
		$avp(ev_attr) = "conference";
		$avp(ev_val) = "1";
	}
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
		if ($avp(g_declines) != NULL && $avp(g_declines) >= $avp(g_windows)) {
			rtpengine_delete();
			$var(group_reply) = "" + $T_reply_code + " " + $(<reply>rr);
			route(group_missed, $var(group_reply));
			exit;
		}
		# A call from the operator: the fallback of its direct number (never after the group declined, above).
		route(did_fallback, "the group did not answer", "480");
		# That fallback was this group, nobody of which answered (review 11a, n°6): the mailbox of the extension the
		# number rings, as after a fallback to an extension (route[voicemail] takes no group's call: the group is set
		# aside while it is tried, given back if the mailbox is not called).
		if ($avp(fb_used) != NULL && $avp(vm_box) != NULL) {
			$(avp(vm_group)[*]) = NULL;
			$avp(vm_group) = $avp(group);
			$(avp(group)[*]) = NULL;
			$avp(vm_then) = "group";
			$avp(vm_code) = 480;
			$avp(vm_reason) = "Temporarily Unavailable";
			route(voicemail, "unavailable");
			$avp(group) = $avp(vm_group);
		}
		rtpengine_delete();
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
	# A call from the operator nobody answered, busy everywhere or that reached nobody: the fallback of its direct
	# number (route[did_fallback]); never after a decline (603, 600).
	if (t_check_status("408|477|480|486|500|503|504") || $var(rang_out) == 1)
		route(did_fallback, "not answered", $var(code));
	# The mailbox of the extension dialled (step 11a): busy or declined (its "busy" greeting), nobody answered or could
	# be reached. Not for any other refusal. If it does not answer, the caller gets the failure tm picked here.
	if (t_check_status("408|477|480|486|500|503|504|600|603") || $var(rang_out) == 1) {
		$avp(vm_then) = "reply";
		# Its reason as RFC 3261 words it (a 408 of tm's own timer has no reply to read it from).
		$avp(vm_code) = $T_reply_code;
		$avp(vm_reason) = "Temporarily Unavailable";
		if (t_check_status("408"))
			$avp(vm_reason) = "Request Timeout";
		else if (t_check_status("477"))
			$avp(vm_reason) = "Send failed";
		else if (t_check_status("486"))
			$avp(vm_reason) = "Busy Here";
		else if (t_check_status("500"))
			$avp(vm_reason) = "Server Internal Error";
		else if (t_check_status("503"))
			$avp(vm_reason) = "Service Unavailable";
		else if (t_check_status("504"))
			$avp(vm_reason) = "Server Time-out";
		else if (t_check_status("600"))
			$avp(vm_reason) = "Busy Everywhere";
		else if (t_check_status("603"))
			$avp(vm_reason) = "Decline";
		if (t_check_status("486|600|603") && $var(rang_out) == 0)
			route(voicemail, "busy");
		else
			route(voicemail, "unavailable");
	}
	# Else the caller gets the best failure (the one tm picked, for the extension that rang), the media session is
	# freed, the missed call accounted.
	rtpengine_delete();
	route(account_missed);
}
