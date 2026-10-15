import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { OUTBOUND_ALLOWABLE } from './numbering.js'

// The OpenSIPS configuration this provider talks to (docker/opensips): rendered by its entrypoint with OpenSIPS
// itself replaced by a stub, then read as text. The real thing is proven by the SIP e2e.
const dir = fileURLToPath(new URL('../../../docker/opensips/', import.meta.url))
const hasEnvsubst = spawnSync('sh', ['-c', 'command -v envsubst']).status === 0
const tmp = mkdtempSync(join(tmpdir(), 'twakephone-opensips-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
writeFileSync(join(tmp, 'cert.pem'), 'test')
writeFileSync(join(tmp, 'key.pem'), 'test')
writeFileSync(join(tmp, 'opensips'), '#!/bin/sh\nexit 0\n')
chmodSync(join(tmp, 'opensips'), 0o755)

const render = (env: Record<string, string> = {}) => {
  const out = join(tmp, `opensips-${Math.random().toString(36).slice(2)}.cfg`)
  const run = spawnSync('sh', [join(dir, 'entrypoint.sh')], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', CFG_TEMPLATE: join(dir, 'opensips.cfg.tpl'), CFG_OUT: out, OPENSIPS_BIN: join(tmp, 'opensips'), TLS_CERT: join(tmp, 'cert.pem'), TLS_KEY: join(tmp, 'key.pem'), ...env },
    encoding: 'utf8'
  })
  return { status: run.status, stderr: run.stderr, cfg: run.status === 0 ? readFileSync(out, 'utf8') : '' }
}

describe.skipIf(!hasEnvsubst)('docker/opensips', () => {
  it('keeps the MI on the loopback when SIP listens on a network', () => {
    const { status, cfg } = render({ LISTEN_IP: '192.0.2.10' })
    expect(status).toBe(0)
    expect(cfg).toContain('socket=udp:192.0.2.10:5060 as 127.0.0.1:5060')
    expect(cfg).toContain('modparam("mi_datagram", "socket_name", "udp:127.0.0.1:8880")')
  })

  it('takes a private MI address, and refuses any other one unless MI_ALLOW_PUBLIC=1', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.2', '192.168.1.5', '10.255.0.9', '169.254.0.1']) {
      const { status, cfg } = render({ MI_LISTEN_IP: ip })
      expect(status, ip).toBe(0)
      expect(cfg).toContain(`"udp:${ip}:8880"`)
    }
    // Not an IPv4 address at all: four numbers from 0 to 255, nothing more, nothing less.
    for (const ip of ['0.0.0.0', '203.0.113.5', '172.32.0.1', '10.example.test', '::', '10.0.0.256', '127.0.0.1.5', '10.0.1', '10..0.1', '10.0.0.1.', '.10.0.0.1', '10.0.0.0001', '192.168.1.*']) {
      const { status, stderr } = render({ MI_LISTEN_IP: ip })
      expect(status, ip).toBe(1)
      expect(stderr).toMatch(/no authentication/)
    }
    expect(render({ MI_LISTEN_IP: '203.0.113.5', MI_ALLOW_PUBLIC: '1' }).status).toBe(0)
  })

  it('announces a call once nothing can refuse it without a transaction: after lookup and rtpengine, just before the relay', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    const lines = (text: string) => text.split('\n').map(l => l.trim())
    // Every call that rings goes through route[ring_now] (route[ring], once the rules its failures may need are read),
    // called once its windows are found (lookup in route[rules_decide]).
    const ring = lines(section('route[ring_now]', 'route[cancelled]'))
    const offer = ring.indexOf('route(rtp_offer);')
    const calling = ring.indexOf('route(calling);', offer)
    expect([offer, calling].every(i => i > 0)).toBe(true)
    // Then the relay, unless the call waits for a browser to wake (step 5): the callee's (route[hold]), or members of
    // a ring group nobody of which has a window (route[group_hold]); the others are woken once their colleagues ring.
    expect(ring.slice(calling + 1).filter(l => l && !l.startsWith('#'))).toEqual([
      'if ($avp(wake) == 1)',
      'route(hold);',
      'if ($avp(group) != NULL && $avp(g_woken) > 0 && $avp(g_windows) == 0)',
      'route(group_hold);',
      '$var(relay_request) = 1;',
      'route(relay_call);',
      '$var(relayed) = $rc;',
      'if ($var(relayed) == 3)',
      'route(wake_next);',
      'if ($var(relayed) == 4)',
      'route(group_dead);',
      'if ($avp(group) != NULL && $avp(g_woken) > 0)',
      'route(group_hold);',
      '}'
    ])
    // One offer per call: a forward after a failure sends the same one on.
    expect(ring[offer - 1]).toBe('if ($avp(rtp_on) == NULL && has_body_part("application/sdp"))')
    expect(section('route[rules_decide]', 'route[preload_query]')).toContain('if (lookup("location"))\n\t\treturn(2);')
    // Nobody to ring: the refusal goes through a transaction (acc sees it), announced just before.
    const unreachable = lines(section('route[unreachable]', 'route[forward_to]'))
    const missed = unreachable.indexOf('route(account_missed);')
    expect(unreachable.slice(missed, missed + 4)).toEqual(['route(account_missed);', 'route(calling);', 'if ($avp(fwd_hops) == 0 && $avp(dialled_unread) != 1)', 't_reply(404, "Not Found");'])
    expect(cfg.match(/raise_event\("E_TWAKEPHONE_CALLING"/g)).toHaveLength(1)
    // The transaction of every call exists before its rules are read and before its relay: a relay that cannot send
    // returns to the script (route[relay_call]) instead of tm answering on its own, unaccounted.
    const main = cfg.slice(cfg.indexOf('\nroute {'), cfg.indexOf('\nroute[ring] {'))
    const newtran = main.indexOf('if (!t_newtran()) {')
    expect(newtran).toBeGreaterThan(main.indexOf('do_accounting("db|evi", "cdr");'))
    expect(newtran).toBeLessThan(main.indexOf('if (is_present_hf("Replaces")) {\n'))
    // The other transaction: a call of the operator (step 6), created where it is accepted, before its number is read.
    expect(cfg.match(/t_newtran/g)).toHaveLength(2)
    const trunkIn = cfg.slice(cfg.indexOf('\nroute[trunk_in] {'), cfg.indexOf('\nroute[trunk_in_loaded] {'))
    expect(trunkIn.indexOf('if (!t_newtran()) {')).toBeGreaterThan(trunkIn.indexOf('do_accounting("db|evi", "cdr");'))
    expect(trunkIn.indexOf('if (!t_newtran()) {')).toBeLessThan(trunkIn.indexOf('async('))
  })

  it('takes the no-answer forward when no window of the callee can be reached, else answers 477, a missed call either way', () => {
    const { cfg } = render()
    const relay = cfg.slice(cfg.indexOf('route[relay_call] {'), cfg.indexOf('onreply_route[rtp] {'))
    expect(relay).toContain('if (!t_relay())\n\t\t$var(relay_rc) = $rc;')
    const forward = relay.indexOf('if ($var(relay_rc) == -6 && $avp(r_noanswer) != NULL) {')
    expect(forward).toBeGreaterThan(0)
    expect(relay.indexOf('route(rules_local);')).toBeGreaterThan(forward)
    expect(relay).toContain('route(forwarded, $var(relay_from), "477");')
    // Nothing to forward to: the missed call, then the reply (477, or 500 for any other failure).
    const missed = relay.lastIndexOf('route(account_missed);')
    expect(missed).toBeGreaterThan(relay.indexOf('route(rules_local);'))
    expect(relay.indexOf('t_reply(477, "Send failed");', missed)).toBeGreaterThan(missed)
    expect(relay.indexOf('t_reply(500, "Internal Error");', missed)).toBeGreaterThan(missed)
    // Every initial INVITE goes through it, in the request route and in failure_route; in-dialog ones keep route[relay].
    expect(cfg.match(/route\(relay_call\);/g)).toHaveLength(3)
    expect(cfg.slice(cfg.indexOf('failure_route[call_failed]')).match(/route\(relay\);/g)).toBeNull()
  })

  it('answers 487 to a call cancelled while its rules were read, before anything rings or is told', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`${name} {`), cfg.indexOf(`${next} {`))
    for (const [resume, next, goOn] of [
      ['route[rules_loaded]', 'route[rules_step]', 'route(rules_step);'],
      ['route[ring_loaded]', 'route[ring_now]', 'route(ring_now);'],
      ['route[names_loaded]', 'route[caller_name]', 'route(ring);'],
      ['route[group_loaded]', 'route[group_ring]', 'route(group_ring);'],
      ['route[wake_loaded]', 'route[hold]', 'route(ring);']
    ] as const) {
      const body = section(resume, next)
      const check = body.indexOf('if (t_was_cancelled())\n\t\troute(cancelled);')
      expect(check, resume).toBeGreaterThan(0)
      expect(body.indexOf(goOn), resume).toBeGreaterThan(check)
    }
    const cancelled = section('route[cancelled]', 'route[name_sql]')
    expect(cancelled).toContain('route(account_missed);\n\tt_reply(487, "Request Terminated");\n\texit;')
    // Nothing told; the only media session to end is the offer made before looking for a browser to wake.
    expect(cancelled.replace(/#.*$/gm, '')).not.toMatch(/calling|raise_event|rtp_offer|rtpengine_offer/)
    expect(cancelled).toContain('if ($avp(rtp_on) != NULL)\n\t\trtpengine_delete();')
  })

  it('reads nothing in failure_route: the rules a failure may need are read before the ringing, asynchronously', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`${name} {`), cfg.indexOf(`${next} {`))
    const ring = section('route[ring]', 'route[ring_loaded]')
    expect(ring).toContain('if ($avp(fwd_hops) < 3 && ($avp(r_busy) != NULL || $avp(r_noanswer) != NULL) && route(preload_query)) {')
    expect(ring).toContain('async(sql_query("$var(preload_query)", ')
    const preload = section('route[preload_query]', 'route[rules_local]')
    const check = preload.indexOf('if (!($avp(callee) =~ "^[A-Za-z0-9._+-]{1,64}$"))')
    expect(check).toBeGreaterThan(0)
    expect(preload.indexOf('$var(preload_query) = "WITH RECURSIVE')).toBeGreaterThan(check)
    expect(preload).toContain(`WHERE c.extension = '" + $avp(callee) + "'`)
    expect(preload).toContain('r.depth < 3')
    // Every list emptied first: sql_query adds to them.
    for (const avp of ['p_ext', 'p_always', 'p_busy', 'p_noanswer', 'p_delay', 'p_dnd', 'p_message', 'p_retry', 'p_name']) expect(preload).toContain(`$(avp(${avp})[*]) = NULL;`)
    // One row per extension reached, with or without rules, and no NULL (sql_query would add "<null>"): the lists stay aligned.
    expect(preload).toContain('FROM (SELECT DISTINCT extension FROM reach) AS x LEFT JOIN call_rules r ON r.extension = x.extension')
    // Each query is asynchronous (the rules, the first of them with the caller's name, the names of a Replaces, the
    // members of a group, the preload, whether the callee can be woken), none is run where async is not available.
    // The trunk of a call to the public network, the direct number of a call from it: step 6). Two synchronous
    // queries ask the catalog whether the tables of step 4c, or that of step 5, exist, only after a read failed, from
    // the routes that resume a read; the third reads the default trunk every 15 s, in a timer of its own, never in a
    // call (an emergency call's fallback when the trunk of the call cannot be read).
    expect(cfg.match(/sql_query/g)).toHaveLength(11)
    expect(cfg.match(/async\(sql_query/g)).toHaveLength(8)
    const timer = cfg.slice(cfg.indexOf('\ntimer_route[default_trunk, 15] {'), cfg.indexOf('\nroute[emergency_failed] {'))
    expect(timer.match(/sql_query_one\(/g)).toHaveLength(1)
    expect(section('route[tables_4c_missing]', 'route[table_5_missing]').match(/sql_query_one\(/g)).toHaveLength(1)
    expect(section('route[table_5_missing]', 'route[wake_next]').match(/sql_query_one\(/g)).toHaveLength(1)
    expect(cfg.match(/route\(tables_4c_missing\)/g)).toHaveLength(1)
    expect(cfg.match(/route\(table_5_missing\)/g)).toHaveLength(1)
    const callers = [...cfg.matchAll(/route\(read_failed\)/g)].map(m => cfg.lastIndexOf('\nroute[', m.index))
    expect(new Set(callers.map(i => cfg.slice(i + 1, cfg.indexOf(']', i)) + ']'))).toEqual(new Set(['route[rules_loaded]', 'route[ring_loaded]', 'route[names_loaded]', 'route[group_loaded]', 'route[wake_loaded]']))
    expect(cfg.slice(cfg.indexOf('failure_route[call_failed]'))).not.toMatch(/sql_query|async\(/)
    expect(cfg.slice(cfg.indexOf('failure_route[call_failed]'))).toContain('route(rules_local);')
    expect(section('route[rules_local]', 'route[rules_preloaded]')).toContain('route(rules_preloaded);')
  })

  it('clears every value of the event attribute lists before building them again', () => {
    const { cfg } = render()
    const start = cfg.indexOf('route[event_attrs]')
    const attrs = cfg.slice(start, cfg.indexOf('failure_route[', start))
    expect(attrs).toContain('$(avp(ev_attr)[*]) = NULL;')
    expect(attrs).toContain('$(avp(ev_val)[*]) = NULL;')
    expect(attrs).not.toMatch(/^\s*\$avp\(ev_(attr|val)\) = NULL;/m)
  })

  it('reads the call rules of an extension whose name cannot break out of the query, with the database clock', () => {
    const { cfg } = render({ OPENSIPS_DB_URL: 'postgres://opensips@db.example.test/opensips' })
    expect(cfg).toContain('loadmodule "sqlops.so"')
    const query = cfg.slice(cfg.indexOf('route[rules_query] {'), cfg.indexOf('route[rules_next] {'))
    const check = query.indexOf('if (!($rU =~ "^[A-Za-z0-9._+-]{1,64}$"))')
    expect(check).toBeGreaterThan(0)
    expect(query.indexOf('$var(rules_query) = "SELECT')).toBeGreaterThan(check)
    expect(query).toContain(`FROM (SELECT 1) AS one LEFT JOIN call_rules r ON r.extension = '" + $rU + "'"`)
    expect(query).toContain('dnd_until > now()')
    // One query, built in one place (the first read adds the caller's name and the group check), read asynchronously.
    expect(cfg.match(/sql_query_one\("\$var\(rules_query\)"/g)).toHaveLength(2)
    expect(cfg.slice(cfg.indexOf('route[rules_next] {'), cfg.indexOf('route[rules_loaded] {'))).toContain('async(sql_query_one("$var(rules_query)", ')
    // At most 3 connections of their own per process for these reads.
    expect(cfg).toContain('\ndb_max_async_connections=3\n')
    expect(cfg.slice(cfg.indexOf('\nroute {'), cfg.indexOf('\nroute[ring] {'))).toContain('route(rules_next);\n\texit;')
  })

  it('bounds every rules query by a short statement_timeout, on connections of their own', () => {
    const sqlops = (env: Record<string, string>) => render(env).cfg.match(/modparam\("sqlops", "db_url", "([^"]*)"\)/)?.[1]
    expect(sqlops({ OPENSIPS_DB_URL: 'postgres://opensips@db.example.test/opensips' })).toBe('postgres://opensips@db.example.test/opensips?options=-cstatement_timeout=1000')
    expect(sqlops({ OPENSIPS_DB_URL: 'postgres://opensips@db.example.test/opensips?sslmode=require', RULES_QUERY_TIMEOUT_MS: '250' })).toBe('postgres://opensips@db.example.test/opensips?sslmode=require&options=-cstatement_timeout=250')
    // acc and auth keep the plain URL: a CDR may take its time.
    expect(render({ OPENSIPS_DB_URL: 'postgres://opensips@db.example.test/opensips' }).cfg).toContain('modparam("acc", "db_url", "postgres://opensips@db.example.test/opensips")')
    for (const bad of ['abc', '1s', '-5']) {
      const { status, stderr } = render({ RULES_QUERY_TIMEOUT_MS: bad })
      expect(status, bad).toBe(1)
      expect(stderr).toMatch(/RULES_QUERY_TIMEOUT_MS/)
    }
    // A "?" in the password is not the start of the parameters (OpenSIPS ends the password at the "@").
    expect(sqlops({ OPENSIPS_DB_URL: 'postgres://opensips:pa?ss@db.example.test/opensips' })).toBe('postgres://opensips:pa?ss@db.example.test/opensips?options=-cstatement_timeout=1000')
    expect(sqlops({ OPENSIPS_DB_URL: 'postgres://opensips:pa?ss@db.example.test/opensips?sslmode=require' })).toBe('postgres://opensips:pa?ss@db.example.test/opensips?sslmode=require&options=-cstatement_timeout=1000')
    // Server options of its own are kept as given (a second options= would replace them), with a warning.
    for (const url of ['postgres://opensips@db.example.test/opensips?options=-csearch_path=voip', 'postgres://opensips@db.example.test/opensips?sslmode=require&options=-csearch_path=voip']) {
      const { status, stderr, cfg } = render({ OPENSIPS_DB_URL: url })
      expect(status, url).toBe(0)
      expect(cfg).toContain(`modparam("sqlops", "db_url", "${url}")`)
      expect(stderr).toMatch(/RULES_QUERY_TIMEOUT_MS is not applied/)
    }
  })

  it('caps the forwards of a call, and sends the INVITE of an attended transfer where the call it replaces went', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`${name} {`), cfg.indexOf(`${next} {`))
    const fwd = section('route[forward_to]', 'route[arm_failure]')
    expect(fwd).toContain('if ($avp(fwd_hops) >= 3) {')
    expect(fwd).toContain('if ($param(1) == $avp(caller) || $(avp(fwd_seen){s.index,$var(seen)}) != NULL) {')
    // acc's callee is the extension reached: the forward moves it.
    expect(fwd).toContain('$acc_extra(callee) = $param(1);')
    // Replaces: the extension the replaced dialog rang (kept by route[ring], and after a forward in failure_route),
    // no rules on the way.
    expect(section('route[ring]', 'route[replaces_target]')).toContain('$dlg_val(callee) = $avp(callee);')
    expect(cfg.slice(cfg.indexOf('failure_route[call_failed]'))).toContain('$dlg_val(callee) = $avp(callee);')
    const target = section('route[replaces_target]', 'route[calling]')
    expect(target).toContain('if (!load_dialog_ctx($var(replaced), "callid"))')
    expect(target).toContain('$var(reached) = $dlg_val(callee);')
    expect(target).toContain('unload_dialog_ctx();')
    // Only an INVITE that names the extension the replaced call dialled goes where that call went.
    expect(section('route[ring_now]', 'route[cancelled]')).toContain('$dlg_val(dialled) = $avp(dialled);')
    expect(target).toContain('$var(was_dialled) = $dlg_val(dialled);')
    expect(target.indexOf('if ($var(was_dialled) == NULL || $var(was_dialled) != $rU)\n\t\treturn(-1);')).toBeLessThan(target.indexOf('$var(replaces_to) = $var(reached);'))
    const main = cfg.slice(cfg.indexOf('\nroute {'), cfg.indexOf('\nroute[ring] {'))
    const replaces = main.slice(main.indexOf('if (is_present_hf("Replaces")) {'), main.indexOf('route(rules_next);'))
    expect(replaces).toContain('$ru = "sip:" + $var(replaces_to) + "@" + $avp(domain);')
    // The names of both parties are read (route[names_loaded] rings), not the rules.
    expect(replaces).toContain('route(names_next);\n\t\texit;')
    expect(replaces.replace(/#.*$/gm, '')).not.toContain('rules')
    expect(section('route[names_loaded]', 'route[caller_name]')).toContain('route(caller_name);\n\troute(ring);')
    // A failure forwards on the statuses the ADR names, and only then; a 486 that comes once the windows rang for
    // the delay (one in a call, another not answered: tm prefers the 486 to its own 408) is a no answer.
    const failure = cfg.slice(cfg.indexOf('failure_route[call_failed]'))
    expect(failure).toContain('if ((t_check_status("600|603") || (t_check_status("486") && $var(rang_out) == 0)) && $avp(r_busy) != NULL)')
    expect(failure).toContain('else if ((t_check_status("408|477|480|503") || $var(rang_out) == 1) && $avp(r_noanswer) != NULL)')
    expect(failure).toContain('$var(rang_for) = $Ts - $avp(ring_at);')
    expect(failure.indexOf('$(avp(ring_at)[*]) = NULL;')).toBeGreaterThan(failure.indexOf('route(forward_to, $var(next))'))
    expect(cfg.slice(cfg.indexOf('onreply_route[rtp]'), cfg.indexOf('route[event_attrs]'))).toContain('$avp(ring_at) = $Ts;')
  })

  it('tells a "do not disturb" and its message only to whoever called that extension', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`${name} {`), cfg.indexOf(`${next} {`))
    const refuse = section('route[dnd_refuse]', 'route[dnd_refuse_dialled]')
    const own = refuse.indexOf('if ($avp(callee) == $avp(dialled)) {')
    expect(own).toBeGreaterThan(0)
    expect(refuse.indexOf('$var(dnd_told) = 1;')).toBeGreaterThan(own)
    // A colleague the call was forwarded to: the dialled extension's own refusal if it has one, else a plain one.
    expect(refuse.indexOf('route(dnd_refuse_dialled);')).toBeGreaterThan(refuse.indexOf('$var(dnd_told) = 1;'))
    expect(refuse.lastIndexOf('$var(dnd_told) = 0;')).toBeGreaterThan(refuse.indexOf('route(dnd_refuse_dialled);'))
    const reply = section('route[dnd_reply]', 'route[forwarded]')
    const told = reply.indexOf('if ($var(dnd_told) == 1) {')
    expect(told).toBeGreaterThan(0)
    for (const header of ['append_to_reply("Twake-Dnd: 1\\r\\n");', 'append_to_reply("Twake-Dnd-Message: $var(dnd_message)\\r\\n");', 'append_to_reply("Retry-After: $var(dnd_retry)\\r\\n");'])
      expect(reply.indexOf(header), header).toBeGreaterThan(told)
    // The other headers added to a reply say why a call to the public network was refused (step 6), and the only body
    // the operator may be sent (415).
    expect(cfg.match(/append_to_reply\((?!"Twake-Call-Refused: |"Accept: application\/sdp\\r\\n"\))/g)).toHaveLength(3)
    expect(reply).toContain('t_reply(480, "Do Not Disturb");')
    expect(reply).toContain('t_reply(480, "Temporarily Unavailable");')
    // Nobody to ring at the end of a forward: the dialled extension's "do not disturb" first.
    const unreachable = section('route[unreachable]', 'route[forward_to]')
    expect(unreachable.indexOf('route(dnd_refuse_dialled);')).toBeGreaterThan(0)
    expect(unreachable.indexOf('route(dnd_refuse_dialled);')).toBeLessThan(unreachable.indexOf('t_reply(404'))
    // Nor when the one it was forwarded to failed (declined, busy, no answer): its missed call waits for that refusal.
    const failure = cfg.slice(cfg.indexOf('failure_route[call_failed]'))
    const dialled = failure.lastIndexOf('if ($avp(d_dnd) == 1)\n\t\troute(dnd_refuse_dialled);')
    expect(dialled).toBeGreaterThan(failure.lastIndexOf('route(relay_call);'))
    expect(dialled).toBeLessThan(failure.lastIndexOf('route(account_missed);'))
    expect(section('route[arm_failure]', 'route[account_missed]')).toContain('if ($avp(d_dnd) != 1 && $avp(group) == NULL)\n\t\t\troute(account_missed);')
    // Only the script tells a "do not disturb": an UA's own Twake-Dnd headers are removed from its replies.
    const onreply = cfg.slice(cfg.indexOf('onreply_route[rtp] {'), cfg.indexOf('route[event_attrs]'))
    expect(onreply.indexOf('remove_hf_glob("Twake-Dnd*");')).toBeGreaterThan(0)
    expect(onreply.indexOf('remove_hf_glob("Twake-Dnd*");')).toBeLessThan(onreply.indexOf('if ($avp(callee) != NULL) {'))
  })

  it('keeps what the caller dialled in the CDRs, next to the extension the call reached', () => {
    const { cfg } = render()
    expect(cfg).toContain('modparam("acc", "extra_fields", "db: caller; callee; dialled")')
    expect(cfg).toContain('modparam("acc", "extra_fields", "evi: caller; callee; dialled")')
    expect(cfg).toContain('$acc_extra(dialled) = $rU;')
    // A number of the public network, in E.164 (step 6); the extension a direct number reaches.
    expect(cfg).toContain('$acc_extra(dialled) = $var(num);')
    expect(cfg).toContain('$acc_extra(dialled) = $avp(did_target);')
    expect(cfg.match(/\$acc_extra\(dialled\)/g)).toHaveLength(3)
  })

  it('shows each party the directory name of the other, never one a phone claims, never one that can break a header', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`${name} {`), cfg.indexOf(`${next} {`))
    // What uac replaces is restored with the dialog (auto): the From and To of a call with the operator, in its replies
    // and in every request of the call, either way. A display name alone is never restored (no URI to restore).
    expect(cfg).toContain('loadmodule "uac.so"')
    expect(cfg).toContain('modparam("uac", "restore_mode", "auto")')
    const callerName = section('route[caller_name]', 'route[group_next]')
    expect(callerName).toContain('if ($avp(named) != NULL)\n\t\treturn(1);')
    expect(callerName.indexOf('if (!($hdr(From) =~ "<"))')).toBeLessThan(callerName.indexOf('uac_replace_from("$var(caller_name)", "");'))
    // The others: the number a call to the operator presents, in place of the extension, and the caller of a call from
    // the operator as read (step 6).
    expect(cfg.match(/uac_replace_from\(/g)).toHaveLength(3)
    expect(callerName).toContain('uac_replace_from("", "$avp(caller_uri)");')
    expect(section('branch_route[trunk_out]', 'route[trunk_number]')).toContain('uac_replace_from("", "sip:$avp(t_from_user)@$avp(t_domain)");')
    // Once the first read resumed (the rules, or the names of a Replaces), before anything rings.
    expect(section('route[rules_loaded]', 'route[rules_step]').indexOf('route(caller_name);')).toBeLessThan(section('route[rules_loaded]', 'route[rules_step]').indexOf('route(rules_step);'))
    // Every name is read through one expression that drops what could end or escape a quoted display name.
    expect(section('route[name_sql]', 'route[names_next]')).toContain(`regexp_replace(translate(n.display_name, chr(34) || chr(92), ''), '[[:cntrl:]]', '', 'g')`)
    expect(cfg.match(/n\.display_name/g)).toHaveLength(1)
    expect(cfg.match(/FROM display_names/g)?.length).toBe(cfg.match(/\$var\(name_sql\) \+ " FROM display_names n WHERE/g)?.length)
    // No identity a phone asserts passes, in a request or in a reply; the answer's is the script's.
    const main = cfg.slice(cfg.indexOf('\nroute {'), cfg.indexOf('\nroute[ring] {'))
    for (const header of ['P-Asserted-Identity', 'P-Preferred-Identity', 'Remote-Party-ID']) expect(main.indexOf(`remove_hf("${header}");`), header).toBeLessThan(main.indexOf('if (!t_newtran()) {'))
    // Nor in a request within a dialog (re-INVITE, UPDATE, BYE...), nor in any reply relayed (the global onreply_route
    // runs for every one, before onreply_route[rtp] asserts who answered).
    const inDialog = main.slice(main.indexOf('if (has_totag()) {'), main.indexOf('route(relay);\n\t\texit;'))
    const anyReply = cfg.slice(cfg.indexOf('\nonreply_route {'), cfg.indexOf('\nonreply_route[rtp] {'))
    for (const header of ['P-Asserted-Identity', 'P-Preferred-Identity', 'Remote-Party-ID']) {
      expect(inDialog, header).toContain(`remove_hf("${header}");`)
      expect(anyReply, header).toContain(`remove_hf("${header}");`)
    }
    // Names not read: the From is left as the phone sent it (never emptied); a call from the operator excepted, whose
    // From never reaches a browser.
    expect(callerName.indexOf('if ($avp(names_read) != 1)\n\t\treturn(-1);')).toBeLessThan(callerName.indexOf('uac_replace_from("$var(caller_name)", "");'))
    const onreply = cfg.slice(cfg.indexOf('onreply_route[rtp] {'), cfg.indexOf('route[event_attrs]'))
    expect(onreply.indexOf('remove_hf("P-Asserted-Identity");')).toBeLessThan(onreply.indexOf('append_hf("P-Asserted-Identity: '))
    expect(onreply).toContain('append_hf("P-Asserted-Identity: \\"$var(pai_name)\\" <sip:$var(pai_ext)@$avp(domain)>\\r\\n");')
    expect(onreply.indexOf('if ($var(pai_ext) =~ "^[A-Za-z0-9._+-]{1,64}$") {')).toBeLessThan(onreply.indexOf('append_hf('))
  })

  it('rings every member of a ring group at once, as dialled only, without anyone in "do not disturb" or anyone\'s rules', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`${name} {`), cfg.indexOf(`${next} {`))
    // A group is a number no account has, checked in the first read; its members are read asynchronously.
    const next = section('route[rules_next]', 'route[rules_loaded]')
    expect(next).toContain(`CASE WHEN EXISTS (SELECT 1 FROM call_groups g WHERE g.number = '" + $rU + "') AND NOT EXISTS (SELECT 1 FROM subscriber s WHERE s.username = '" + $rU + "') THEN 1 ELSE 0 END`)
    const step = section('route[rules_step]', 'route[rules_decide]')
    expect(step).toContain('if ($avp(fwd_hops) == 0 && $avp(d_loaded) == NULL && $avp(r_group) == 1) {')
    expect(step.indexOf('route(group_next);')).toBeLessThan(step.indexOf('route(rules_decide);'))
    const query = section('route[group_next]', 'route[group_loaded]')
    expect(query).toContain(`WHERE g.number = '" + $rU + "' AND x.ext <> '" + $var(group_caller) + "'`)
    expect(query).toContain('NOT EXISTS (SELECT 1 FROM call_rules r WHERE r.extension = x.ext AND r.dnd AND (r.dnd_until IS NULL OR r.dnd_until > now()))')
    expect(query).toContain('ORDER BY x.pos')
    for (const avp of ['g_ext', 'g_name']) expect(query).toContain(`$(avp(${avp})[*]) = NULL;`)
    // Each window is a branch that knows its member; nobody to ring is a refusal through the transaction.
    const ring = section('route[group_ring]', 'route[group_window]')
    expect(ring).toContain('if ($var(ext) =~ "^[A-Za-z0-9._+-]{1,64}$") {')
    expect(ring).toContain('lookup("location", "to-branches-only", "$var(aor)")')
    // At most 12 destinations (MAX_BRANCHES): rank by rank, each member's first window before anyone's second; the
    // windows left out are logged.
    expect(ring).toContain('if ($(avp(w_rank)[$var(j)]) == $var(rank)) {')
    // A member woken by a push (step 5) takes one of them, and the branch that keeps the call waiting another.
    expect(ring).toContain('if ($var(placed) >= $var(cap)) {')
    expect(ring).toContain('$var(cap) = 12;\n\tif ($var(woken) > 0)\n\t\t$var(cap) = 11 - $var(woken);')
    expect(ring).toContain('while ($msg.branch.last_idx > 0)\n\t\t\t\tremove_msg_branch(0);')
    expect(ring).toContain('xlog("L_WARN", "call $ci: group $avp(group): $var(left) of its $var(windows) windows left out, a call rings 12 at most\\n");')
    expect(ring).toContain('$avp(g_windows) = $var(placed);')
    const window = section('route[group_window]', 'route[replaces_target]')
    expect(window).toContain('$(msg.branch.attr(gext)[$var(k)]) = $(avp(w_ext)[$var(w)]);')
    expect(window).toContain('$(msg.branch.attr(gname)[$var(k)]) = $(avp(w_name)[$var(w)]);')
    for (const avp of ['r_always', 'r_busy', 'r_noanswer', 'r_dnd']) expect(ring).toContain(`$(avp(${avp})[*]) = NULL;`)
    expect(ring).toContain('route(account_missed);\n\t\troute(calling);\n\t\tt_reply(480, "Temporarily Unavailable");')
    expect(ring.replace(/#.*$/gm, '').trimEnd().endsWith('route(ring);\n}')).toBe(true)
    // A member declining leaves the colleagues ringing; any other call is declined as a whole (its windows that
    // answered something are cancelled).
    expect(cfg).toContain('modparam("tm", "disable_6xx_block", 1)')
    const onreply = cfg.slice(cfg.indexOf('onreply_route[rtp] {'), cfg.indexOf('route[event_attrs]'))
    expect(onreply).toContain('if ($rs >= 600 && $avp(group) == NULL)\n\t\t\tt_cancel_branch("o");')
    // The member who answers becomes the callee: CDR, dialog (Replaces), events.
    for (const line of ['$avp(callee) = $var(member);', '$acc_extra(callee) = $var(member);', '$dlg_val(callee) = $var(member);']) expect(onreply).toContain(line)
    expect(onreply).toContain('$avp(ev_callee) = $var(member);')
    // A group nobody answered: no forward from failure_route; the refusal only when every window declined (counted
    // once per branch in onreply_route[rtp]), else 480; the missed call says what the caller was told.
    const failure = cfg.slice(cfg.indexOf('failure_route[call_failed]'))
    expect(failure.indexOf('if ($avp(group) != NULL) {')).toBeLessThan(failure.indexOf('route(forward_to, $var(next))'))
    const group = failure.slice(failure.indexOf('if ($avp(group) != NULL) {'), failure.indexOf('$var(dnd_code) = $T_reply_code;'))
    expect(group).toContain('if ($avp(g_declines) != NULL && $avp(g_declines) >= $avp(g_windows)) {')
    expect(group).toContain('route(group_missed, "480 Temporarily Unavailable");\n\t\tt_reply(480, "Temporarily Unavailable");')
    expect(onreply).toContain('$var(mark) = ",b" + $T_branch_idx + ",";')
    // A member woken by a push (step 5) declines once, whatever the number of windows they opened.
    expect(onreply).toContain('if ($var(woken_window) == 1)\n\t\t\t\t$var(mark) = ",m" + $var(member) + ",";')
    expect(failure).toContain('route(group_missed, "487 Request Terminated");')
    const missed = section('route[group_missed]', 'route[dnd_refuse]')
    expect(missed).toContain('acc_db_request("$param(1)", "missed_calls");')
    expect(missed).toContain('acc_evi_request("$param(1)");')
    expect(section('route[event_attrs]', 'failure_route[call_failed]')).toContain('$avp(ev_attr) = "group";')
  })

  it('reads the forwards and the "do not disturb" of step 4b even where the tables of step 4c are missing', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`${name} {`), cfg.indexOf(`${next} {`))
    expect(cfg).toContain('modparam("cfgutils", "shvset", "no4c_until=i:0")')
    // Each query names call_groups or display_names only while they may be (route[tables_4c]), else NULL columns.
    const query = section('route[rules_query]', 'route[rules_next]')
    expect(query.indexOf('$var(name_col) = "NULL";')).toBeLessThan(query.indexOf('if (route(tables_4c)) {'))
    const next = section('route[rules_next]', 'route[rules_loaded]')
    expect(next.indexOf('$var(first_cols) = ", NULL, 0";')).toBeLessThan(next.indexOf('if ($avp(q4c) == 1)'))
    expect(section('route[preload_query]', 'route[rules_local]').indexOf('$var(name_col) = "\'\'";')).toBeLessThan(section('route[preload_query]', 'route[rules_local]').indexOf('if (route(tables_4c)) {'))
    expect(section('route[names_next]', 'route[names_loaded]')).toContain('if (!route(tables_4c)) {')
    // A failed read is made again once (a dropped connection is made anew by the next query); the tables are left
    // out only when the database says one is missing (to_regclass), never on a guess from the time a query took.
    const failed = section('route[read_failed]', 'route[tables_4c_missing]')
    expect(failed).toContain('if ($avp(q_again) == 1) {')
    expect(failed).toContain('if ($avp(q4c) == 1 && route(tables_4c_missing)) {\n\t\t$shv(no4c_until) = $Ts + 30;')
    expect(failed).toContain('return(1);')
    const probe = section('route[tables_4c_missing]', 'route[group_next]')
    expect(probe).toContain("to_regclass('call_groups') IS NULL OR to_regclass('display_names') IS NULL")
    expect(cfg).not.toMatch(/\$Tsm|q_start|q4c_retry|q_ms/)
    expect(section('route[rules_loaded]', 'route[rules_step]')).toContain('if ($var(rules_rc) < 0 && $var(rules_rc) != -2 && route(read_failed)) {\n\t\troute(rules_next);\n\t\texit;\n\t}')
    expect(section('route[ring_loaded]', 'route[ring_now]')).toContain('if ($var(rules_rc) < 0 && $var(rules_rc) != -2 && route(read_failed)) {\n\t\troute(ring);\n\t\texit;\n\t}')
    expect(section('route[names_loaded]', 'route[caller_name]')).toContain('if ($var(names_rc) < 0 && $var(names_rc) != -2 && route(read_failed)) {\n\t\troute(names_next);\n\t\texit;\n\t}')
    expect(section('route[group_loaded]', 'route[group_ring]')).toContain('if ($var(group_rc) < 0 && $var(group_rc) != -2 && route(read_failed)) {')
    expect(section('route[group_loaded]', 'route[group_ring]')).toContain('\t\troute(group_next);\n\t\texit;\n\t}')
    // The members' query always needs call_groups: its failure is never taken for missing tables.
    expect(section('route[group_next]', 'route[group_loaded]')).toContain('$(avp(q4c)[*]) = NULL;')
  })

  it('holds a call to someone without a window while the Gateway wakes their browser, from the request route only, once per call', () => {
    const { cfg } = render({ PUSH_WAIT_SEC: '25' })
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`${name} {`), cfg.indexOf(`${next} {`))
    expect(cfg).toContain('loadmodule "event_routing.so"')
    expect(cfg).toContain('modparam("cfgutils", "shvset", "no5_until=i:0")')
    // Nobody registered: a browser to wake is looked for once per extension, from the request route only.
    const decide = section('route[rules_decide]', 'route[preload_query]')
    const lookup = decide.indexOf('if (lookup("location"))\n\t\treturn(2);')
    const wake = decide.indexOf('if ($var(may_wake) == 1 && $avp(held) == NULL && ($avp(wake_checked) == NULL || $avp(wake_checked) != $avp(callee)))\n\t\treturn(3);')
    expect(wake).toBeGreaterThan(lookup)
    expect(wake).toBeLessThan(decide.indexOf('route(forward_to, $avp(r_noanswer))'))
    expect(section('route[rules_step]', 'route[rules_decide]')).toContain('$var(may_wake) = 1;\n\troute(rules_decide);')
    expect(section('route[rules_local]', 'route[rules_preloaded]')).toContain('$var(may_wake) = 0;')
    // One asynchronous read on the primary key, the user part checked first, the media offer made before it.
    const next = section('route[wake_next]', 'route[wake_loaded]')
    expect(next.indexOf('$avp(wake_checked) = $avp(callee);')).toBeLessThan(next.indexOf('async('))
    expect(next.indexOf('!($avp(callee) =~ "^[A-Za-z0-9._+-]{1,64}$")')).toBeLessThan(next.indexOf('$var(wake_query) ='))
    expect(next.indexOf('route(rtp_offer);')).toBeLessThan(next.indexOf('async('))
    // Only while a Gateway listens for the events that say whom to wake (it keeps alive_until ahead, and lets it go
    // once it stops): nobody else would wake the browser, the call would wait for nothing.
    expect(next).toContain(`$var(wake_query) = "SELECT 1 FROM push_targets WHERE extension = '" + $avp(callee) + "' AND alive_until > now()";`)
    expect(section('route[group_next]', 'route[group_loaded]')).toContain('EXISTS (SELECT 1 FROM push_targets p WHERE p.extension = x.ext AND p.alive_until > now())')
    expect(next).toContain('async(sql_query_one("$var(wake_query)", "$avp(wake_row)"), wake_loaded);')
    expect(next).toContain('if ($shv(no5_until) > $Ts || ')
    // The table missing (to_regclass, never a guess): nobody woken for 30 s, the read made again without it.
    const failed = section('route[read_failed]', 'route[tables_4c_missing]')
    expect(failed).toContain('if ($avp(q5) == 1 && route(table_5_missing)) {\n\t\t$shv(no5_until) = $Ts + 30;')
    expect(section('route[table_5_missing]', 'route[wake_next]')).toContain("to_regclass('push_targets') IS NULL")
    expect(section('route[group_next]', 'route[group_loaded]')).toContain('if ($shv(no5_until) <= $Ts && $avp(g_nowake) == NULL) {\n\t\t$avp(q5) = 1;')
    // The members' query failed while it named push_targets (a table of the first version of step 5, without
    // alive_until): made again without it, the group still rings its members' windows.
    expect(section('route[group_loaded]', 'route[group_ring]')).toContain('if ($avp(q5) == 1)\n\t\t\t$avp(g_nowake) = 1;\n\t\troute(group_next);')
    // Nobody to wake: on as before; windows that could not be reached end as a failed relay, never in a loop.
    const notWoken = section('route[not_woken]', 'route[hold]')
    expect(notWoken.indexOf('route(relay_failed);')).toBeLessThan(notWoken.indexOf('route(rules_step);'))
    expect(section('route[wake_loaded]', 'route[not_woken]')).toContain('if ($var(wake_rc) == 1) {\n\t\t$avp(wake) = 1;')
    // The hold: the no-answer delay, else PUSH_WAIT_SEC; a phony branch armed with it; the window that registers
    // rings in the transaction; the Gateway told (E_TWAKEPHONE_WAKE); the caller hears it ringing.
    const hold = section('route[hold]', 'route[woken]')
    expect(hold).toContain('$var(wait) = 25;')
    expect(hold).toContain('if ($avp(r_noanswer) != NULL && $avp(r_delay) != NULL)\n\t\t$var(wait) = $avp(r_delay);')
    expect(hold.indexOf('$T_fr_inv_timeout = $var(wait);')).toBeLessThan(hold.indexOf('t_wait_for_new_branches()'))
    expect(hold).toContain('$avp(wake_filter) = "aor=" + $avp(callee);')
    // A window that registers, or one back with the Contact it had (a WebSocket that died, reconnected).
    for (const event of ['E_UL_CONTACT_INSERT', 'E_UL_CONTACT_UPDATE']) expect(hold).toContain(`notify_on_event("${event}", $avp(wake_filter), "woken", $var(wait))`)
    // A window that registered before the registrations were followed (while the table was read) rings: not woken.
    expect(hold.indexOf('if (route(registered_meanwhile))\n\t\texit;')).toBeGreaterThan(hold.indexOf('notify_on_event("E_UL_CONTACT_UPDATE"'))
    expect(hold.indexOf('if (route(registered_meanwhile))')).toBeLessThan(hold.indexOf('raise_event("E_TWAKEPHONE_WAKE"'))
    const meanwhile = section('route[registered_meanwhile]', 'route[past_dead_branches]')
    expect(meanwhile).toContain('lookup("location", "to-branches-only", "$var(aor)")')
    expect(meanwhile).toContain('remove_msg_branch($var(i));')
    expect(meanwhile.indexOf('if (!t_relay()) {')).toBeLessThan(meanwhile.indexOf('t_wait_no_more_branches();'))
    // Its relay failed after adding a branch (a WebSocket that died meanwhile): a set of its own with a phony branch,
    // so that a CANCEL still ends the call at once; none added, the phony branch is still alone in its set.
    expect(meanwhile).toContain('if ($(tm.branch.uri[-1]) != "") {\n\t\t\troute(past_dead_branches);\n\t\t\tif (!t_wait_for_new_branches()) {')
    expect(hold.indexOf('raise_event("E_TWAKEPHONE_WAKE"')).toBeLessThan(hold.indexOf('t_reply(180, "Ringing");'))
    // Windows that could not be reached: their failed branches left behind first, so that a CANCEL ends the wait at
    // once (a relay that adds no branch, to a transport OpenSIPS does not listen on), the destination reset after.
    expect(hold.indexOf('if ($avp(relay_dead) == 1)\n\t\troute(past_dead_branches);')).toBeLessThan(hold.indexOf('t_wait_for_new_branches()'))
    const past = section('route[past_dead_branches]', 'route[woken]')
    expect(past).toContain('$du = "sip:127.0.0.1:9;transport=sctp";\n\tt_relay();\n\tresetdsturi();')
    // Only the Request-URI, and no socket a ring group's window forced: else that relay adds a failed branch.
    expect(past.indexOf('while ($msg.branch.last_idx > 0)\n\t\tremove_msg_branch(0);')).toBeLessThan(past.indexOf('$du = '))
    expect(past.indexOf('$socket_out = NULL;')).toBeLessThan(past.indexOf('$du = '))
    expect(cfg).not.toMatch(/listen\s*=\s*sctp/)
    // Injected as any branch; the branch route ends the wait for a branch it lets go (not for a renewal it drops).
    expect(section('route[woken]', 'route[group_hold]')).toContain('if (!t_inject_branches("event"))')
    expect(cfg).not.toContain('t_inject_branches("event", "l")')
    expect(hold.indexOf('$avp(held_one) = 1;')).toBeGreaterThan(hold.indexOf('t_wait_for_new_branches()'))
    // A group: the woken members' windows are tagged with the member, and the wait counts one branch per member.
    const groupHold = section('route[group_hold]', 'route[group_woken]')
    // Counted per member: the wait has no limit of branches, it stops once each woken member had a window answer.
    expect(groupHold).toContain('if (t_wait_for_new_branches())')
    expect(groupHold).toContain('$avp(g_wake_list) = $var(list);')
    for (const event of ['E_UL_CONTACT_INSERT', 'E_UL_CONTACT_UPDATE']) expect(groupHold).toContain(`notify_on_event("${event}", $avp(wake_filter), "group_woken", $var(wait))`)
    const joined = cfg.slice(cfg.indexOf('onreply_route[rtp] {'), cfg.indexOf('route[event_attrs]'))
    expect(joined).toContain('if ($var(nj) >= $avp(g_woken))\n\t\t\t\t\tt_wait_no_more_branches();')
    // A group none of whose windows can be reached: its members are woken (those without a window first), not 477.
    const dead = section('route[group_dead]', 'route[group_woken]')
    expect(dead).toContain('$var(room) = 11 - $avp(g_windows);')
    expect(dead.indexOf('route(past_dead_branches);')).toBeLessThan(dead.indexOf('route(group_hold);'))
    expect(section('route[relay_call]', 'route[relay_failed]')).toContain('if ($var(relay_rc) == -6 && $var(relay_request) == 1 && $avp(group) != NULL && $avp(held) == NULL && ($avp(gd_ext) != NULL || $avp(g_woken) > 0))\n\t\treturn(4);')
    expect(groupHold).toContain('$avp(ev_callee) = $var(member);')
    expect(section('route[group_woken]', 'route[group_next]')).toContain('$(msg.branch.attr(gext)[0]) = $avp(aor);')
    // Only the request route holds: failure_route says so before it may relay, and never reaches the hold.
    const failure = cfg.slice(cfg.indexOf('failure_route[call_failed]'))
    expect(failure).toContain('$var(relay_request) = 0;')
    expect(failure).not.toMatch(/route\((hold|group_hold|wake_next|not_woken)\)/)
    const relay = section('route[relay_call]', 'route[relay_failed]')
    expect(relay).toContain('if ($var(relay_rc) == -6 && $var(relay_request) == 1 && $avp(group) == NULL && $avp(held) == NULL && ')
    // Never for an INVITE with Replaces (an attended transfer): a window that opens could not carry that dialog.
    expect(relay).toContain('$avp(held) == NULL && !is_present_hf("Replaces") && ')
    // The windows tried by the relay, so that route[registered_meanwhile] knows which are new.
    expect(relay.indexOf('$avp(seen_dst) = $var(seen);')).toBeLessThan(relay.indexOf('if (!t_relay())'))
    expect(section('route[relay_failed]', 'onreply_route')).toContain('$var(relay_request) = 0;')
    // A woken callee or member is an event attribute of its own; nothing the UA sent goes in it.
    expect(cfg.match(/raise_event\("E_TWAKEPHONE_WAKE"/g)).toHaveLength(2)
  })

  it('tries each destination once per call, keeps their place to the woken members of a ring group, and declares the probe of the Gateway', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`${name} {`), cfg.indexOf(`${next} {`))
    // Every branch of a call, the relays' and those a registration injects, goes through the branch route.
    const ringNow = section('route[ring_now]', 'route[cancelled]')
    expect(ringNow.indexOf('t_on_branch("tried");')).toBeLessThan(ringNow.indexOf('route(hold);'))
    expect(cfg.match(/t_on_branch\("tried"\)/g)).toHaveLength(1)
    // The others: each INVITE to the operator (its first server, the next ones, a challenge answered, the default trunk
    // of an emergency call) through branch_route[trunk_out].
    expect(cfg.match(/t_on_branch\(/g)).toHaveLength(5)
    expect(cfg.match(/t_on_branch\("trunk_out"\)/g)).toHaveLength(4)
    const tried = cfg.slice(cfg.indexOf('branch_route[tried] {'), cfg.indexOf('#### Ring groups'))
    // A Contact on the connection it rang on already: dropped (a renewal); on another connection: another destination.
    expect(tried).toContain('$var(key) = " " + $ru;\n\tif ($du != NULL)\n\t\t$var(key) = $var(key) + "|" + $du;')
    expect(tried).toContain('if ($avp(tried) != NULL && $(avp(tried){s.index,$var(key)}) != NULL) {')
    expect(tried.indexOf('drop();')).toBeLessThan(tried.indexOf('$avp(tried) = $var(tried);'))
    // A woken member's first window takes the place kept for them; another one only while places remain for the others.
    expect(tried).toContain('$tm.branch.attr(gext) != NULL && $tm.branch.attr(gname) == NULL')
    expect(tried).toContain('$var(left) = 11 - $T_branch_idx;\n\t\t\t\tif ($var(left) < $avp(g_awaited)) {')
    const groupHold = section('route[group_hold]', 'route[group_woken]')
    expect(groupHold).toContain('$avp(g_injected) = ",";\n\t$avp(g_awaited) = $avp(g_woken);')
    // The wait of a held callee ends with the first branch that goes, as t_inject_branches' "l" did.
    expect(tried.trimEnd().endsWith('if ($avp(held_one) == 1)\n\t\tt_wait_no_more_branches();\n}')).toBe(true)
    // The event the Gateway raises itself through the MI to know it hears OpenSIPS: declared, raised nowhere else.
    expect(section('route[probe_event]', 'failure_route[call_failed]')).toContain('raise_event("E_TWAKEPHONE_PROBE");')
    expect(cfg.match(/E_TWAKEPHONE_PROBE/g)).toHaveLength(1)
    expect(cfg).not.toMatch(/route\(probe_event\)/)
  })

  it('gives the trunk a socket of its own, on the loopback unless told otherwise, and never the SIP one', () => {
    expect(render().cfg).toContain('socket=udp:127.0.0.1:5070\n')
    expect(render({ LISTEN_IP: '192.0.2.10', TRUNK_LISTEN_IP: '192.0.2.11', TRUNK_PORT: '5080', TRUNK_ADVERTISE: '198.51.100.7:5080' }).cfg).toContain(
      'socket=udp:192.0.2.11:5080 as 198.51.100.7:5080\n'
    )
    expect(render({ TRUNK_PORT: '5060' }).stderr).toMatch(/TRUNK_PORT must differ from SIP_PORT/)
    expect(render({ TRUNK_LISTEN_IP: '127.0.0.2', TRUNK_PORT: '5060' }).status).toBe(0)
    for (const [env, error] of [
      [{ TRUNK_PORT: '50x' }, /TRUNK_PORT must be a port number/],
      [{ TRUNK_PORT: '70000' }, /TRUNK_PORT must be 1 to 65535/],
      [{ TRUNK_LISTEN_IP: '0.0.0.0' }, /TRUNK_LISTEN_IP=0\.0\.0\.0 must be/],
      [{ TRUNK_LISTEN_IP: '2001:db8::1' }, /TRUNK_LISTEN_IP=2001:db8::1 must be an IPv4 address/],
      [{ TRUNK_ADVERTISE: 'a b' }, /TRUNK_ADVERTISE must be host or host:port/],
      [{ TRUNK_ADVERTISE: '2001:db8::1' }, /TRUNK_ADVERTISE must be host or host:port/],
      [{ TRUNK_MAX_CALL_SEC: '59' }, /TRUNK_MAX_CALL_SEC must be 60 to 86400/],
      [{ TRUNK_MAX_CALL_SEC: '1h' }, /TRUNK_MAX_CALL_SEC must be a number/]
    ] as const) {
      const { status, stderr } = render(env)
      expect(status, JSON.stringify(env)).toBe(1)
      expect(stderr).toMatch(error)
    }
    // Its servers probed from it, every 15 s; the registrations and the numbering plan read from the database.
    const { cfg } = render()
    expect(cfg).toContain('modparam("dispatcher", "ds_probing_sock", "udp:127.0.0.1:5070")')
    expect(cfg).toContain('modparam("dispatcher", "ds_ping_interval", 15)')
    for (const module of ['dispatcher', 'dialplan', 'uac_auth', 'uac_registrant']) expect(cfg).toContain(`loadmodule "${module}.so"`)
    // A server that answers nothing is down: the 408 tm makes up for an OPTIONS left unanswered is no answer.
    const codes = /modparam\("dispatcher", "options_reply_codes", "([0-9,]+)"\)/.exec(cfg)?.[1]?.split(',')
    expect(codes).toEqual(['401', '403', '404', '405', '407', '500', '501', '503'])
  })

  it('lets out only the numbers a trunk may call, the emergency ones always, and says why the others are refused', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    const main = cfg.slice(cfg.indexOf('\nroute {'), cfg.indexOf('\nroute[outbound_policy] {'))
    // A number of the public network is classified before anything is read or rings, and leaves through the trunk
    // only (not lookup, nor the rules of an extension): a call transferred (Replaces) stays where it is.
    const classify = main.indexOf('if (!is_present_hf("Replaces") && dp_translate(1, "$rU", $var(num), $var(num_class)))')
    expect(classify).toBeGreaterThan(0)
    expect(classify).toBeLessThan(main.indexOf('if (!t_newtran()) {'))
    expect(main.indexOf('if ($var(pstn) == 1) {\n\t\troute(trunk_out);\n\t\texit;\n\t}')).toBeGreaterThan(main.indexOf('if (!t_newtran()) {'))
    expect(main).toContain('$avp(num_class) = $var(num_class);')
    const policy = section('route[outbound_policy]', 'route[trunk_out]')
    // An emergency number goes to the trunk, before any other class is read; a premium one never.
    expect(policy.indexOf('if ($var(num_class) == "emergency") {\n\t\t$var(pstn) = 1;\n\t\treturn(1);\n\t}')).toBeGreaterThan(0)
    expect(policy.indexOf('if ($var(num_class) == "emergency")')).toBeLessThan(policy.indexOf('dp_translate(2,'))
    expect(policy).not.toContain('Emergency Calls Not Routed')
    expect(policy).toContain('send_reply(484, "Address Incomplete");')
    expect(policy).toContain('send_reply(403, "Destination Not Allowed");')
    // The classes that may go on are those a trunk may be allowed (OUTBOUND_ALLOWABLE), never `premium`.
    const allowed = [...policy.matchAll(/case "([a-z-]+)":/g)].map(m => m[1]).filter(c => c !== 'invalid')
    expect(allowed.sort()).toEqual([...OUTBOUND_ALLOWABLE].sort())
    expect(cfg.match(/\$var\(pstn\) = 1;/g)).toHaveLength(2)
    expect(policy.match(/\$var\(pstn\) = 1;/g)).toHaveLength(2)
    // What the trunk allows is checked once it is read; an emergency number skips that check and keeps its digits.
    const loaded = section('route[trunk_out_loaded]', 'route[trunk_number]')
    const internal = loaded.indexOf('if ($avp(t_internal) != NULL')
    const check = loaded.indexOf('if ($avp(num_class) != "emergency") {\n\t\t$var(mark) = "," + $avp(num_class) + ",";')
    expect([internal, check].every(i => i > 0)).toBe(true)
    expect(internal).toBeLessThan(check)
    expect(loaded).toContain('if ($avp(t_allowed) == NULL || $(avp(t_allowed){s.index,$var(mark)}) == NULL)\n\t\t\t$var(allowed) = 0;')
    // An international number only to a country code the trunk lists (",44,"), read on its first one to three digits.
    expect(loaded).toContain('if ($avp(num_class) == "international" && $var(allowed) == 1) {\n\t\t\t$var(allowed) = 0;')
    expect(loaded).toContain('$var(cc) = "," + $(avp(callee){s.substr,1,$var(i)}) + ",";')
    expect(loaded).toContain('if ($avp(t_countries) == NULL) {\n\t\t\t\t$var(allowed) = 0;')
    expect(loaded).toContain('if ($(avp(t_countries){s.index,$var(cc)}) != NULL)\n\t\t\t\t\t\t$var(allowed) = 1;')
    // The North American plan (+1) per area: its own ("1876", Jamaica), or `1` for an area none of dialplan's set 4
    // names (the United States and Canada); never through `1` alone for the other countries of the plan.
    const nanp = loaded.slice(loaded.indexOf('} else if ($avp(callee) =~ "^\\+1") {'), loaded.indexOf('} else {\n\t\t\t\t$var(i) = 1;'))
    expect(nanp).toContain('$var(cc) = "," + $(avp(callee){s.substr,1,4}) + ",";')
    expect(nanp).toContain('$var(cc) = ",1,";\n\t\t\t\tif ($(avp(t_countries){s.index,$var(cc)}) != NULL && !dp_translate(4, "$avp(callee)", $var(nanp)))\n\t\t\t\t\t$var(allowed) = 1;')
    expect(nanp).not.toContain('$var(i)')
    // A number in E.164 as the operator writes them; a short one (112, 116006...) as dialled.
    expect(section('route[trunk_target]', 'branch_route[trunk_out]')).toContain('$var(to_user) = $avp(callee);\n\tif ($avp(callee) =~ "^\\+") {\n\t\troute(trunk_number, $avp(callee));')
    // No trunk at all: an emergency number is told to be called from another phone, anything else has no trunk.
    const noTrunk = loaded.slice(loaded.indexOf('if ($var(trunk_rc) == -2) {'), loaded.indexOf('if ($var(trunk_rc) < 0) {'))
    expect(noTrunk).toContain('append_to_reply("Twake-Call-Refused: emergency\\r\\n");\n\t\t\tt_reply(403, "Emergency Calls Not Routed");')
    expect(noTrunk).toContain('append_to_reply("Twake-Call-Refused: no-trunk\\r\\n");\n\t\tt_reply(503, "No Trunk");')
    // One of our own direct numbers rings inside, as if dialled (its rules, groups...), never through the operator.
    expect(loaded.slice(internal, check)).toContain('route(rules_next);\n\t\texit;')
  })

  it('answers the challenge of each server once, never passes one on, and tries another server only while nothing rang', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    const failed = section('failure_route[trunk_failed]', 'route[emergency_fallback]')
    expect(failed).toContain('if ($avp(t_challenged) == NULL && $avp(t_pass) != NULL && $avp(t_pass) != "") {')
    // A challenge left unanswered (a second one, no password): 503 no-trunk to the browser, not the operator's 401/407.
    const challenge = failed.slice(failed.indexOf('if (t_check_status("401|407")) {'), failed.indexOf('if (t_check_status("408|5[0-9][0-9]")'))
    expect(challenge.trimEnd().endsWith('append_to_reply("Twake-Call-Refused: no-trunk\\r\\n");\n\t\tt_reply(503, "Trunk Authentication Failed");\n\t\texit;\n\t}')).toBe(true)
    // The next server: only for no answer at all or an error before any provisional answer; challenged anew there.
    const next = failed.slice(failed.indexOf('if (t_check_status("408|5[0-9][0-9]") && $avp(t_rang) == NULL && ds_next_dst()) {'))
    expect(next.length).toBeGreaterThan(0)
    expect(next).toContain('$(avp(t_challenged)[*]) = NULL;')
    // Each retry with the From and To of the operator (branch_route[trunk_out]), as the first INVITE.
    for (const retry of [challenge, next]) expect(retry.indexOf('t_on_branch("trunk_out");')).toBeLessThan(retry.indexOf('if (t_relay())'))
    // Every retry goes to the number at the operator's domain, not back to what was dialled at ours.
    expect(failed.indexOf('$ru = $avp(t_ruri);')).toBeGreaterThan(0)
    expect(failed.indexOf('$ru = $avp(t_ruri);')).toBeLessThan(failed.indexOf('if (t_check_status("401|407")) {'))
    expect(section('route[trunk_out_loaded]', 'route[trunk_number]')).toContain('$avp(t_ruri) = $ru;')
    // A redirection is never followed, and its Contact never reaches the phone: 480.
    expect(failed.replace(/#.*$/gm, '').trimEnd().endsWith('if (t_check_status("3[0-9][0-9]")) {\n\t\txlog("L_NOTICE", "call $ci: the operator redirected the call ($T_reply_code), not followed\\n");\n\t\tt_reply(480, "Temporarily Unavailable");\n\t}\n}')).toBe(true)
    // A provisional reply past 100 Trying (180, 183...) holds the call to that server; 100 only says the INVITE arrived.
    expect(section('onreply_route[rtp]', 'route[event_attrs]')).toContain('if ($rs > 100 && $rs < 200 && $dlg_val(trunk) == "callee")\n\t\t$avp(t_rang) = 1;')
    expect(section('route[trunk_out_loaded]', 'route[trunk_number]')).toContain('$(avp(t_rang)[*]) = NULL;')
  })

  it('never lets an emergency call depend on the database, cuts it at TRUNK_MAX_CALL_SEC, or fail without saying to call from another phone', () => {
    const { cfg } = render({ TRUNK_MAX_CALL_SEC: '7200' })
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    // The default trunk, read every 15 s into shared variables; none: 0.
    expect(cfg).toContain('modparam("cfgutils", "shvset", "dt_setid=i:0")')
    const timer = section('timer_route[default_trunk, 15]', 'route[emergency_failed]')
    expect(timer).toContain('FROM trunks ORDER BY position LIMIT 1')
    expect(timer).toContain('$shv(dt_setid) = $var(d_setid);')
    expect(timer).toContain('} else if ($rc == -2) {\n\t\t# No trunk any more.\n\t\t$shv(dt_setid) = 0;')
    // Taken for an emergency call when the trunk could not be read, or none of its servers is up.
    const fallback = section('route[default_trunk]', 'timer_route[default_trunk, 15]')
    expect(fallback).toContain('if ($shv(dt_setid) == 0 || ($avp(t_setid) != NULL && $avp(t_setid) == $shv(dt_setid)))\n\t\treturn(-1);')
    const loaded = section('route[trunk_out_loaded]', 'route[trunk_headers]')
    expect(loaded).toContain('if ($avp(num_class) == "emergency" && route(default_trunk)) {')
    expect(loaded).toContain('if (!route(default_trunk) || !ds_select_dst($avp(t_setid), 8, "f")) {\n\t\t\troute(emergency_failed, "no server up");')
    // Never cut at TRUNK_MAX_CALL_SEC.
    expect(loaded).toContain('if ($avp(num_class) == "emergency")\n\t\t$DLG_timeout = 604800;\n\telse\n\t\t$DLG_timeout = 7200;')
    // Every failure of it, the operator's refusal included: "call from another phone".
    expect(section('route[emergency_failed]', 'route[trunk_out_loaded]')).toContain('append_to_reply("Twake-Call-Refused: emergency\\r\\n");\n\tt_reply(503, "Emergency Call Failed");')
    const failed = section('failure_route[trunk_failed]', 'route[trunk_in]')
    expect(failed).toContain('if ($avp(num_class) == "emergency") {\n\t\t$var(failed) = "" + $T_reply_code;\n\t\troute(emergency_failed, $var(failed));\n\t\texit;\n\t}')
    expect(failed.indexOf('route(emergency_failed, $var(failed));')).toBeLessThan(failed.indexOf('if (t_check_status("3[0-9][0-9]")) {'))
  })

  it('never lets a call with the operator be transferred by it, from either side', () => {
    const { cfg } = render()
    const main = cfg.slice(cfg.indexOf('\nroute {'), cfg.indexOf('\nroute[outbound_policy] {'))
    const inDialog = main.slice(main.indexOf('if (has_totag()) {'), main.indexOf('if (is_method("CANCEL")) {'))
    const refer = inDialog.indexOf('if (is_method("REFER") && $dlg_val(trunk) != NULL) {')
    expect(refer).toBeGreaterThan(inDialog.indexOf('if (!match_dialog()) {'))
    expect(refer).toBeLessThan(inDialog.indexOf('route(relay);'))
    expect(inDialog.slice(refer)).toMatch(/^[^]*?send_reply\(403, "Transfer Not Allowed"\);\n\t\t\texit;/)
    // Nor completed by an INVITE with Replaces of such a call.
    expect(cfg).toContain('\tif ($dlg_val(trunk) != NULL)\n\t\t$var(replaces_trunk) = 1;\n\tunload_dialog_ctx();')
    const replaced = main.indexOf('if ($var(replaces_trunk) == 1) {')
    expect(replaced).toBeGreaterThan(main.indexOf('route(replaces_target);'))
    expect(replaced).toBeLessThan(main.indexOf('record_route();'))
  })

  it('hears the operator only on the trunk socket: out of a dialog from its addresses, in one of its calls from any', () => {
    const { cfg } = render()
    const main = cfg.slice(cfg.indexOf('\nroute {'), cfg.indexOf('\nroute[outbound_policy] {'))
    const known = main.indexOf('if ($socket_in(ip) == "127.0.0.1" && $socket_in(port) == 5070 && !ds_is_in_list("$si", 0)) {')
    expect(known).toBeGreaterThan(0)
    expect(known).toBeLessThan(main.indexOf('if (has_totag()) {'))
    // Out of a dialog from an address the trunk does not declare: 403. In one: a stranger, judged below.
    expect(main.slice(known)).toMatch(/^[^]*?if \(!has_totag\(\)\) \{[^]*?send_reply\(403, "Forbidden"\);\n\t\t\texit;\n\t\t\}\n\t\t\$var\(stranger\) = 1;/)
    const inDialog = main.slice(main.indexOf('if (has_totag()) {'), main.indexOf('if (is_method("CANCEL")) {'))
    // Not let through by the shortcut of an ACK to a transaction: through the Record-Route and the dialog like the rest.
    expect(inDialog).toContain('if (is_method("ACK") && $var(stranger) == 0 && t_check_trans()) {')
    const judged = inDialog.indexOf('if ($var(stranger) == 1) {\n\t\t\tif ($dlg_val(trunk) == NULL || route(to_trunk) || !is_method("BYE|INVITE|ACK|UPDATE|PRACK")) {')
    // After loose_route and match_dialog (our Record-Route, a dialog of ours), before anything is relayed: only the
    // operator's side of a call with it, never a request to it nor one in a call between two accounts, and only what
    // a media gateway sends in a call (no OPTIONS, INFO, NOTIFY, REFER, MESSAGE...).
    expect(judged).toBeGreaterThan(inDialog.indexOf('if (!match_dialog()) {'))
    expect(judged).toBeLessThan(inDialog.indexOf('route(relay);'))
    expect(inDialog.slice(judged)).toMatch(/^[^]*?if \(!is_method\("ACK"\)\)\n\t\t\t\t\tsend_reply\(403, "Forbidden"\);\n\t\t\t\texit;/)
    // A CANCEL from such an address: only that of an INVITE of the operator still ringing (its transaction).
    const cancel = main.indexOf('if (is_method("CANCEL") && t_check_trans()) {', known)
    expect(cancel).toBeGreaterThan(known)
    expect(cancel).toBeLessThan(main.indexOf('if (!has_totag()) {', known))
  })

  it('takes a request of the operator in a call to the phone of that call only, whatever its Request-URI names', () => {
    const { cfg } = render()
    const main = cfg.slice(cfg.indexOf('\nroute {'), cfg.indexOf('\nroute[outbound_policy] {'))
    const inDialog = main.slice(main.indexOf('if (has_totag()) {'), main.indexOf('if (is_method("CANCEL")) {'))
    // The operator's side of a call (any of its addresses): to the Contact the phone gave, kept by the dialog; its
    // Route headers and Request-URI are not followed.
    const fromTrunk = inDialog.indexOf('if ($dlg_val(trunk) != NULL && !route(to_trunk)) {\n\t\t\t$var(from_trunk) = 1;\n\t\t\tif (!fix_route_dialog()) {')
    expect(fromTrunk).toBeGreaterThan(inDialog.indexOf('if ($var(stranger) == 1) {'))
    expect(fromTrunk).toBeLessThan(inDialog.indexOf('route(relay);'))
    expect(inDialog.slice(fromTrunk)).toMatch(/^[^]*?send_reply\(500, "Internal Error"\);\n\t\t\t\texit;/)
    // Its answers go back through onreply_route[rtp], which takes the extension out of the phone's Contact.
    expect(inDialog).toContain('if ($var(from_trunk) == 1) {\n\t\t\t$avp(reply_to_trunk) = 1;\n\t\t\tt_on_reply("rtp");\n\t\t}\n\t\troute(relay);')
  })

  it('sends the operator only the headers a call needs, whatever the phone added', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    const headers = section('route[trunk_headers]', 'route[trunk_number]')
    const allowed = /if \(!\(\$var\(name\) =~ "([^"]+)"\)\)\n\t\t\tremove_hf\("\$var\(name\)"\);/.exec(headers)?.[1]
    expect(allowed).toBeDefined()
    // Every header, by its name in lower case, all of them in turn.
    expect(headers).toContain('while ($(hdr_name[$var(h)]) != NULL) {\n\t\t$var(name) = $(hdr_name[$var(h)]{s.tolower});')
    const kept = (name: string) => new RegExp(allowed ?? 'never').test(name.toLowerCase())
    for (const name of ['Via', 'v', 'Max-Forwards', 'From', 'To', 'Call-ID', 'i', 'CSeq', 'Contact', 'm', 'Route', 'Content-Type', 'Content-Length', 'l', 'Allow', 'Supported', 'Require', 'Session-Expires', 'Min-SE', 'RAck', 'RSeq'])
      expect(kept(name), name).toBe(true)
    for (const name of ['Diversion', 'History-Info', 'P-Charge-Info', 'P-Called-Party-ID', 'P-Preferred-Service', 'P-Preferred-Identity', 'P-Asserted-Identity', 'Remote-Party-ID', 'Privacy', 'Referred-By', 'Reply-To', 'Alert-Info', 'Call-Info', 'Organization', 'Subject', 's', 'User-Agent', 'X-Account', 'Twake-Anything', 'Via-Fake', 'ToX'])
      expect(kept(name), name).toBe(false)
    // On the initial INVITE, whose From, To and P-Asserted-Identity of ours are written for each branch after it
    // (branch_route[trunk_out]); on every request of a call to the operator.
    const loaded = section('route[trunk_out_loaded]', 'route[trunk_headers]')
    expect(loaded.indexOf('route(trunk_headers);')).toBeLessThan(loaded.indexOf('t_on_branch("trunk_out");'))
    expect(loaded).not.toContain('uac_replace_from(')
    expect(loaded).not.toContain('append_hf("P-Asserted-Identity')
    const branch = section('branch_route[trunk_out]', 'route[trunk_number]')
    expect(branch).toContain('if ($avp(t_pai) == 1)\n\t\tappend_hf("P-Asserted-Identity: <sip:$avp(t_from_user)@$avp(t_domain)>\\r\\n");')
    expect(cfg).toContain('\t\tif (route(to_trunk)) {\n\t\t\troute(trunk_headers);\n\t\t\troute(trunk_contact);\n\t\t}')
  })

  it('makes rtpengine take an offer made in a 2xx (an INVITE without SDP) and its answer in the ACK', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    const main = cfg.slice(cfg.indexOf('\nroute {'), cfg.indexOf('\nroute[outbound_policy] {'))
    const inDialog = main.slice(main.indexOf('if (has_totag()) {'), main.indexOf('if (is_method("CANCEL")) {'))
    expect(inDialog).toContain('} else if (is_method("INVITE")) {\n\t\t\troute(late_offer);\n\t\t\tt_on_reply("rtp");\n\t\t}')
    expect(inDialog).toContain('if (is_method("ACK") && $dlg_val(late_answer) == "1" && has_body_part("application/sdp")) {')
    expect(section('route[trunk_in]', 'route[inbound_number]')).toContain('if (!has_body_part("application/sdp")) {\n\t\t$(avp(late_offer)[*]) = NULL;\n\t\t$avp(late_offer) = "trunk";')
    // A SIP phone's call to the operator without SDP: the operator's offer in its 2xx through rtpengine, never as sent.
    expect(section('route[trunk_out_loaded]', 'route[trunk_headers]')).toContain('if (has_body_part("application/sdp")) {\n\t\troute(rtp_offer);\n\t} else {\n\t\t$(avp(late_offer)[*]) = NULL;\n\t\t$avp(late_offer) = "browser";\n\t}')
    const reply = section('onreply_route[rtp]', 'route[event_attrs]')
    expect(reply).toContain('if ($avp(late_offer) != NULL) {\n\t\t\tif ($rs >= 200 && $rs < 300)\n\t\t\t\troute(rtp_late_offer);\n\t\t} else {\n\t\t\troute(rtp_answer);')
    expect(section('route[rtp_late_offer]', 'route')).toContain('$dlg_val(late_answer) = "1";')
  })

  it('bounds every call with the operator, and ends it with a BYE to both sides at TRUNK_MAX_CALL_SEC', () => {
    const { cfg } = render({ TRUNK_MAX_CALL_SEC: '7200' })
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    // Every INVITE gets its dialog; a call that goes to the operator, its flags once that is known (one of our own
    // direct numbers stays an internal call, route[trunk_out_loaded]).
    expect(cfg.slice(cfg.indexOf('\nroute {'), cfg.indexOf('\nroute[outbound_policy] {'))).toContain('\n\tcreate_dialog();\n')
    const loaded = section('route[trunk_out_loaded]', 'route[trunk_headers]')
    const flags = loaded.indexOf('if ($avp(num_class) == "emergency")\n\t\tcreate_dialog("B");\n\telse\n\t\tcreate_dialog("BP");')
    expect(flags).toBeGreaterThan(loaded.indexOf('route(rules_next);\n\t\texit;'))
    expect(cfg.match(/\$DLG_timeout = 7200;/g)).toHaveLength(2)
    expect(cfg).toContain('\tcreate_dialog("Bp");\n\t$DLG_timeout = 7200;\n\t$dlg_val(trunk) = "caller";')
    expect(render().cfg).toContain('$DLG_timeout = 14400;')
  })

  it('ends a call with the operator when its phone stops answering the OPTIONS of the dialog, every CALL_PING_SEC', () => {
    // The phone's side only: the caller's (P) of a call out, the callee's (p) of a call in; never the operator's.
    const { cfg } = render({ CALL_PING_SEC: '12' })
    expect(cfg).toContain('modparam("dialog", "options_ping_interval", 12)')
    // Never for an emergency call (B only): the emergency services hang up themselves, a silent phone must not cut them.
    expect(cfg.replace(/#.*$/gm, '').match(/create_dialog\(("[^"]*")?\)/g)).toEqual(['create_dialog()', 'create_dialog("B")', 'create_dialog("BP")', 'create_dialog("Bp")'])
    expect(render().cfg).toContain('modparam("dialog", "options_ping_interval", 30)')
    expect(render({ CALL_PING_SEC: '5' }).status).toBe(0)
    expect(render({ CALL_PING_SEC: '300' }).status).toBe(0)
    for (const v of ['4', '301', 'abc', '10s', '-5']) {
      const { status, stderr } = render({ CALL_PING_SEC: v })
      expect(status, v).toBe(1)
      expect(stderr).toMatch(/CALL_PING_SEC/)
    }
    // Nothing else ends a call: no MI command of the Gateway's does (dlg_end_dlg is never sent, ADR 0016).
    expect(cfg).not.toContain('dlg_end_dlg')
    // One OPTIONS unanswered ends the call (dialog counts no failures): it waits CALL_PING_TIMEOUT_SEC for its answer
    // (tm retransmits it meanwhile), not the 5 s of fr_timeout; only the dialog's (with a To-tag), not dispatcher's.
    const local = cfg.slice(cfg.indexOf('\nlocal_route {'), cfg.indexOf('\nonreply_route {'))
    expect(local).toContain('if (is_method("OPTIONS") && has_totag()) {\n\t\t$T_fr_timeout = 15;')
    expect(render({ CALL_PING_TIMEOUT_SEC: '40' }).cfg).toContain('$T_fr_timeout = 40;')
    expect(render({ CALL_PING_TIMEOUT_SEC: '5' }).status).toBe(0)
    expect(render({ CALL_PING_TIMEOUT_SEC: '60' }).status).toBe(0)
    for (const v of ['4', '61', 'abc', '10s', '-5']) {
      const { status, stderr } = render({ CALL_PING_TIMEOUT_SEC: v })
      expect(status, v).toBe(1)
      expect(stderr).toMatch(/CALL_PING_TIMEOUT_SEC/)
    }
  })

  it('frees the media of a call in rtpengine at once when OpenSIPS ends it (its phone gone, TRUNK_MAX_CALL_SEC)', () => {
    const { cfg } = render()
    // The dialog's BYEs (both parties) go through local_route: rtpengine_delete once, without its 30 s delay.
    const local = cfg.slice(cfg.indexOf('\nlocal_route {'), cfg.indexOf('\nonreply_route {'))
    expect(local).toContain('} else if (is_method("BYE") && $dlg_val(rtp_freed) != "1") {\n\t\t$dlg_val(rtp_freed) = "1";\n\t\trtpengine_delete("delete-delay=0");\n\t}')
    expect(cfg.match(/rtpengine_delete\("delete-delay=0"\)/g)).toHaveLength(1)
  })

  it('tells the operator nothing of the inside: the number as it writes them in the To, no version, no "do not disturb" nor refusal of ours', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    expect(cfg).toContain('server_header="Server: TwakePhone"\nuser_agent_header="User-Agent: TwakePhone"')
    expect(section('branch_route[trunk_out]', 'route[trunk_number]')).toContain('uac_replace_to("", "sip:$avp(t_to_user)@$avp(t_domain)");')
    const dnd = section('route[dnd_reply]', 'route[forwarded]')
    expect(dnd.indexOf('if ($dlg_val(trunk) == "caller")\n\t\t$var(dnd_told) = 0;')).toBeLessThan(dnd.indexOf('append_to_reply("Twake-Dnd: 1\\r\\n");'))
    expect(cfg.slice(cfg.indexOf('\nonreply_route {'), cfg.indexOf('\nonreply_route[rtp] {'))).toContain('remove_hf("Twake-Call-Refused");')
    expect(section('onreply_route[rtp]', 'route[event_attrs]')).toContain('remove_hf("Twake-Call-Refused");')
  })

  it('puts an emergency call its trunk refuses or fails through the default trunk, once', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    const failed = section('failure_route[trunk_failed]', 'route[emergency_fallback]')
    // A challenge it could not answer, or any final failure (403, 5xx...) once its other servers were tried: before
    // the call is given up (its media freed, "call from another phone").
    const challenge = failed.slice(failed.indexOf('if (t_check_status("401|407")) {'), failed.indexOf('if (t_check_status("408|5[0-9][0-9]")'))
    const rest = failed.slice(failed.indexOf('if (t_check_status("408|5[0-9][0-9]")'))
    for (const path of [challenge, rest]) {
      expect(path).toMatch(/if \(route\(emergency_fallback\)\)\n\t+exit;/)
      expect(path.indexOf('route(emergency_fallback)')).toBeLessThan(path.indexOf('rtpengine_delete();'))
      expect(path.indexOf('route(emergency_fallback)')).toBeLessThan(path.indexOf('route(emergency_failed'))
    }
    expect(rest.indexOf('route(emergency_fallback)')).toBeGreaterThan(rest.indexOf('ds_next_dst()'))
    // An emergency call only, once; through the default trunk, unless that is the trunk that failed (route[default_trunk]).
    const fallback = section('route[emergency_fallback]', 'route[trunk_in]')
    expect(fallback).toContain('if ($avp(num_class) != "emergency" || $avp(t_fallback) != NULL)\n\t\treturn(-1);\n\t$avp(t_fallback) = 1;')
    expect(fallback).toContain('if (!route(default_trunk) || !ds_select_dst($avp(t_setid), 8, "f"))\n\t\treturn(-1);')
    // Written for that trunk (its number, its domain, its socket), its From and To for each branch, its failure handled here again.
    for (const step of ['route(trunk_target);', 't_on_branch("trunk_out");', 't_on_reply("rtp");', 't_on_failure("trunk_failed");', 'if (t_relay())\n\t\treturn(1);'])
      expect(fallback.indexOf(step), step).toBeGreaterThan(fallback.indexOf('route(default_trunk)'))
  })

  it('sends the operator a request that says once what it is, with SDP as its only body', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    const request = section('route[trunk_request]', 'route[trunk_contact]')
    // Exactly one From, To, Call-ID and CSeq ($hdrcnt counts the compact forms: f, t, i), at most one of the others.
    for (const name of ['From', 'To', 'Call-ID', 'CSeq']) expect(request).toContain(`$hdrcnt(${name}) != 1`)
    for (const name of ['Max-Forwards', 'Content-Type', 'Content-Length']) expect(request).toContain(`$hdrcnt(${name}) > 1`)
    expect(request).toContain('$var(refuse_code) = 400;')
    // A body that is not SDP (multipart with an ISUP part, anything else): 415.
    const sdp = /\(\$\(hdr\(Content-Type\)\{s\.tolower\}\) =~ "([^"]+)"\)/.exec(request)?.[1]
    expect(sdp).toBeDefined()
    const sdpOnly = (type: string) => new RegExp((sdp ?? 'never').replace('[[:space:]]', '\\s')).test(type.toLowerCase())
    for (const type of ['application/sdp', 'Application/SDP', 'application/sdp;charset=utf-8', 'application/sdp ; x=1']) expect(sdpOnly(type), type).toBe(true)
    for (const type of ['multipart/mixed;boundary=b1', 'multipart/mixed; boundary="application/sdp"', 'application/isup;version=itu-t92+', 'application/sdpx', 'text/plain', 'x-application/sdp', ''])
      expect(sdpOnly(type), type).toBe(false)
    expect(request).toContain('if ($rb != NULL && $(rb{s.len}) > 0 && !(')
    // The initial INVITE before anything is recorded (an emergency call's caller told to call from another phone), and
    // every request of a call to the operator, before it is relayed.
    const main = cfg.slice(cfg.indexOf('\nroute {'), cfg.indexOf('\nroute[outbound_policy] {'))
    const initial = main.indexOf('if ($var(pstn) == 1 && !route(trunk_request)) {')
    expect(initial).toBeGreaterThan(0)
    expect(initial).toBeLessThan(main.indexOf('record_route();'))
    expect(main.slice(initial)).toMatch(/^[^]*?if \(\$var\(num_class\) == "emergency"\)\n\t\t\tappend_to_reply\("Twake-Call-Refused: emergency\\r\\n"\);[^]*?send_reply\(\$var\(refuse_code\), "\$var\(refuse_reason\)"\);\n\t\texit;/)
    const inDialog = main.slice(main.indexOf('if (has_totag()) {'), main.indexOf('if (is_method("CANCEL")) {'))
    const sequential = inDialog.indexOf('if (route(to_trunk) && !route(trunk_request)) {')
    expect(sequential).toBeGreaterThan(0)
    expect(sequential).toBeLessThan(inDialog.indexOf('route(relay);'))
  })

  it('gives the operator a Contact without the extension, in each request and answer of the phone', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    const contact = section('route[trunk_contact]', 'route[trunk_target]')
    // One Contact, ours: the phone's address without its user part nor the parameters of its header.
    expect(contact).toContain('remove_hf("Contact");')
    expect(contact).toContain('append_hf("Contact: <$var(ct)>\\r\\n");')
    const subst = /\$\(ct\.fields\(uri\)\{re\.subst,\/([^/]+)\/([^/]+)\/\}\)/
    const [, pattern, replacement] = subst.exec(contact) ?? []
    expect(pattern).toBeDefined()
    const rewrite = (uri: string) => uri.replace(new RegExp(pattern ?? 'never'), (replacement ?? '').replace(/\\(\d)/g, '$$$1'))
    expect(rewrite('sip:301@192.0.2.5:5062;transport=udp')).toBe('sip:192.0.2.5:5062;transport=udp')
    expect(rewrite('sip:k7b2x9@127.0.0.1:41234;transport=ws;ob')).toBe('sip:127.0.0.1:41234;transport=ws;ob')
    expect(rewrite('sips:301@192.0.2.5:5061')).toBe('sips:192.0.2.5:5061')
    expect(rewrite('sip:192.0.2.5:5062')).toBe('sip:192.0.2.5:5062')
    expect(rewrite('sip:192.0.2.5;x=a@b')).toBe('sip:192.0.2.5;x=a@b')
    // The same rewrite read in the main route, after fix_nated_contact, for the INVITE resumed later.
    const main = cfg.slice(cfg.indexOf('\nroute {'), cfg.indexOf('\nroute[outbound_policy] {'))
    expect(main).toContain(`if ($var(pstn) == 1)\n\t\t$avp(t_contact) = $(ct.fields(uri){re.subst,/${pattern}/${replacement}/});`)
    expect(main.indexOf('$avp(t_contact) =')).toBeGreaterThan(main.indexOf('fix_nated_contact();\n\t# The Contact'))
    // Where: the INVITE to the operator, every request of a call to it, every answer of the phone to it (its call,
    // its request in one).
    expect(section('route[trunk_out_loaded]', 'route[trunk_headers]')).toContain('route(trunk_contact, $avp(t_contact));')
    expect(main).toContain('\t\t\troute(trunk_contact);\n')
    const trunkIn = section('route[trunk_in]', 'route[inbound_number]')
    expect(trunkIn.indexOf('\n\t$avp(reply_to_trunk) = 1;')).toBeGreaterThan(trunkIn.indexOf('$dlg_val(trunk) = "caller";'))
    expect(trunkIn.indexOf('$dlg_val(trunk) = "caller";')).toBeGreaterThan(0)
    const reply = section('onreply_route[rtp]', 'route[event_attrs]')
    expect(reply.indexOf('if ($avp(reply_to_trunk) == 1)\n\t\troute(trunk_contact);')).toBeGreaterThan(reply.indexOf('fix_nated_contact();'))
  })

  it('reads the caller of the operator in the national forms only operators send, and hides it under Privacy: id or user', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    expect(section('route[inbound_number]', 'route[trunk_in_loaded]')).toContain('if (!dp_translate(1, "$var(in)", $var(n), $var(n_class)) && !dp_translate(3, "$var(in)", $var(n), $var(n_class)))')
    const trunkIn = section('route[trunk_in]', 'route[inbound_number]')
    for (const what of ['$rU', '$tU', '$fU']) expect(trunkIn).toContain(`route(inbound_number, ${what})`)
    // Every Privacy header (all their values, joined), any case: `id` or `user` hides the caller, nothing else does.
    expect(trunkIn).toContain('if (is_present_hf("Privacy")) {\n\t\t$var(privacy) = $(hdr(Privacy)[*]{s.tolower});')
    const privacy = /\$var\(privacy\) =~ "([^"]+)"\)\n\t\t\t\$var\(from_number\) = "anonymous";/.exec(trunkIn)?.[1]
    expect(privacy).toBeDefined()
    const hides = (value: string) => new RegExp(privacy ?? 'never').test(value.toLowerCase())
    for (const value of ['id', 'user', 'none, user', 'header;id', 'ID', 'header, critical, user']) expect(hides(value), value).toBe(true)
    for (const value of ['none', 'header', 'session', 'critical', 'identity', 'userinfo']) expect(hides(value), value).toBe(false)
    // The browser sees the caller as read, never the operator's From.
    expect(section('route[caller_name]', 'route[tables_4c]')).toContain('if ($avp(caller_uri) != NULL) {\n\t\tuac_replace_from("", "$avp(caller_uri)");')
  })

  it('takes calls on the trunk socket from the operator only, and rings what its direct number names', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    const main = cfg.slice(cfg.indexOf('\nroute {'), cfg.indexOf('\nroute[outbound_policy] {'))
    expect(main).toContain('if ($socket_in(ip) == "127.0.0.1" && $socket_in(port) == 5070) {\n\t\troute(trunk_in);\n\t\texit;\n\t}')
    expect(main.indexOf('route(trunk_in);')).toBeLessThan(main.indexOf('www_authorize('))
    const trunkIn = section('route[trunk_in]', 'route[inbound_number]')
    for (const header of ['Route', 'P-Asserted-Identity', 'P-Preferred-Identity', 'Remote-Party-ID']) expect(trunkIn).toContain(`remove_hf("${header}");`)
    expect(trunkIn).toContain('send_reply(404, "Not Found");')
    // The extension the number reaches rings as if it were dialled: its rules, forwards, "do not disturb", groups, push.
    expect(section('route[trunk_in_loaded]', 'route[ring]')).toContain('route(rules_next);')
  })

  it('refuses a PUSH_WAIT_SEC that is no number of seconds from 5 to 120', () => {
    for (const v of ['4', '121', 'abc', '10s', '-5']) {
      const { status, stderr } = render({ PUSH_WAIT_SEC: v })
      expect(status, v).toBe(1)
      expect(stderr).toMatch(/PUSH_WAIT_SEC/)
    }
    expect(render({ PUSH_WAIT_SEC: '5' }).status).toBe(0)
    expect(render({ PUSH_WAIT_SEC: '120' }).cfg).toContain('$var(wait) = 120;')
    expect(render().cfg).toContain('$var(wait) = 30;')
  })

  it('never answers 404 for a number whose rules could not be read: it may be a ring group', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`${name} {`), cfg.indexOf(`${next} {`))
    const lines = (text: string) => text.split('\n').map(l => l.trim())
    expect(section('route[rules_loaded]', 'route[rules_step]')).toContain('if ($avp(d_loaded) == NULL && $avp(fwd_hops) == 0)\n\t\t\t$avp(dialled_unread) = 1;')
    const unreachable = lines(section('route[unreachable]', 'route[forward_to]'))
    const reply = unreachable.indexOf('t_reply(404, "Not Found");')
    expect(unreachable.slice(reply - 1, reply + 3)).toEqual(['if ($avp(fwd_hops) == 0 && $avp(dialled_unread) != 1)', 't_reply(404, "Not Found");', 'else', 't_reply(480, "Temporarily Unavailable");'])
  })
})
