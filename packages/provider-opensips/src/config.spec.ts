import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

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
    expect(ring[calling + 1]).toBe('route(relay_call);')
    // One offer per call: a forward after a failure sends the same one on.
    expect(ring[offer - 1]).toBe('if ($avp(rtp_on) == NULL && has_body_part("application/sdp"))')
    expect(section('route[rules_decide]', 'route[preload_query]')).toContain('if (lookup("location"))\n\t\treturn(2);')
    // Nobody to ring: the refusal goes through a transaction (acc sees it), announced just before.
    const unreachable = lines(section('route[unreachable]', 'route[forward_to]'))
    const missed = unreachable.indexOf('route(account_missed);')
    expect(unreachable.slice(missed, missed + 4)).toEqual(['route(account_missed);', 'route(calling);', 'if ($avp(fwd_hops) == 0)', 't_reply(404, "Not Found");'])
    expect(cfg.match(/raise_event\("E_TWAKEPHONE_CALLING"/g)).toHaveLength(1)
    // The transaction of every call exists before its rules are read and before its relay: a relay that cannot send
    // returns to the script (route[relay_call]) instead of tm answering on its own, unaccounted.
    const main = cfg.slice(cfg.indexOf('\nroute {'), cfg.indexOf('\nroute[ring] {'))
    const newtran = main.indexOf('if (!t_newtran()) {')
    expect(newtran).toBeGreaterThan(main.indexOf('do_accounting("db|evi", "cdr");'))
    expect(newtran).toBeLessThan(main.indexOf('if (is_present_hf("Replaces")) {\n'))
    expect(cfg.match(/t_newtran/g)).toHaveLength(1)
  })

  it('takes the no-answer forward when no window of the callee can be reached, else answers 477, a missed call either way', () => {
    const { cfg } = render()
    const relay = cfg.slice(cfg.indexOf('route[relay_call] {'), cfg.indexOf('onreply_route[rtp]'))
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
    expect(cfg.slice(cfg.indexOf('failure_route[')).match(/route\(relay\);/g)).toBeNull()
  })

  it('answers 487 to a call cancelled while its rules were read, before anything rings or is told', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`${name} {`), cfg.indexOf(`${next} {`))
    for (const [resume, next, goOn] of [['route[rules_loaded]', 'route[rules_step]', 'route(rules_step);'], ['route[ring_loaded]', 'route[ring_now]', 'route(ring_now);']] as const) {
      const body = section(resume, next)
      const check = body.indexOf('if (t_was_cancelled())\n\t\troute(cancelled);')
      expect(check, resume).toBeGreaterThan(0)
      expect(body.indexOf(goOn), resume).toBeGreaterThan(check)
    }
    const cancelled = section('route[cancelled]', 'route[replaces_target]')
    expect(cancelled).toContain('route(account_missed);\n\tt_reply(487, "Request Terminated");\n\texit;')
    expect(cancelled).not.toMatch(/rtp|calling|raise_event/)
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
    for (const avp of ['p_ext', 'p_always', 'p_busy', 'p_noanswer', 'p_delay', 'p_dnd', 'p_message', 'p_retry']) expect(preload).toContain(`$(avp(${avp})[*]) = NULL;`)
    // Each query is asynchronous, none is run where async is not available.
    expect(cfg.match(/sql_query/g)).toHaveLength(2)
    expect(cfg.match(/async\(sql_query/g)).toHaveLength(2)
    expect(cfg.slice(cfg.indexOf('failure_route['))).not.toMatch(/sql_query|async\(/)
    expect(cfg.slice(cfg.indexOf('failure_route['))).toContain('route(rules_local);')
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
    expect(query).toContain(`FROM call_rules WHERE extension = '" + $rU + "'"`)
    expect(query).toContain('dnd_until > now()')
    // One query, built in one place, read asynchronously.
    expect(cfg.match(/sql_query_one\("\$var\(rules_query\)"/g)).toHaveLength(1)
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
    expect(cfg.slice(cfg.indexOf('failure_route['))).toContain('$dlg_val(callee) = $avp(callee);')
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
    expect(replaces).toContain('route(ring);\n\t\texit;')
    expect(replaces.replace(/#.*$/gm, '')).not.toContain('rules')
    // A failure forwards on the statuses the ADR names, and only then; a 486 that comes once the windows rang for
    // the delay (one in a call, another not answered: tm prefers the 486 to its own 408) is a no answer.
    const failure = cfg.slice(cfg.indexOf('failure_route['))
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
    expect(cfg.match(/append_to_reply\(/g)).toHaveLength(3)
    expect(reply).toContain('t_reply(480, "Do Not Disturb");')
    expect(reply).toContain('t_reply(480, "Temporarily Unavailable");')
    // Nobody to ring at the end of a forward: the dialled extension's "do not disturb" first.
    const unreachable = section('route[unreachable]', 'route[forward_to]')
    expect(unreachable.indexOf('route(dnd_refuse_dialled);')).toBeGreaterThan(0)
    expect(unreachable.indexOf('route(dnd_refuse_dialled);')).toBeLessThan(unreachable.indexOf('t_reply(404'))
    // Nor when the one it was forwarded to failed (declined, busy, no answer): its missed call waits for that refusal.
    const failure = cfg.slice(cfg.indexOf('failure_route['))
    const dialled = failure.lastIndexOf('if ($avp(d_dnd) == 1)\n\t\troute(dnd_refuse_dialled);')
    expect(dialled).toBeGreaterThan(failure.lastIndexOf('route(relay_call);'))
    expect(dialled).toBeLessThan(failure.lastIndexOf('route(account_missed);'))
    expect(section('route[arm_failure]', 'route[account_missed]')).toContain('if ($avp(d_dnd) != 1)\n\t\t\troute(account_missed);')
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
    expect(cfg.match(/\$acc_extra\(dialled\)/g)).toHaveLength(1)
  })
})
