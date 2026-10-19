import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FRAUD_DEFAULTS } from '@twake/telephony-types'
import { afterAll, describe, expect, it } from 'vitest'
import { OUTBOUND_ALLOWABLE } from './numbering.js'
import { EMERGENCY_RESTORED_SEC } from './outbound.js'

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

  it('gives LiveKit SIP a socket of its own that hears its address only, nothing when Meet is off, and only the HA1 of its account (step 8)', () => {
    const off = render()
    expect(off.status).toBe(0)
    // No socket at all when Meet is off: nothing hears on its port (review n°17).
    expect(off.cfg).not.toMatch(/^socket=udp:[^\n]*:5090/m)
    expect(off.cfg).toContain('# None: Meet is off (MEET_SIP empty).')
    expect(off.cfg).toContain('modparam("cfgutils", "shvset", "meet_on=i:0")')
    expect(off.cfg).toContain('$ru = "sip:8000@meet.invalid";')
    const password = 'not-a-real-secret-0'
    const on = render({ SIP_DOMAIN: 'sip.example.test', MEET_SIP: '192.0.2.20:5080', MEET_SIP_PASSWORD: password, MEET_NUMBER: '7000' })
    expect(on.status, on.stderr).toBe(0)
    expect(on.cfg).toContain('modparam("cfgutils", "shvset", "meet_on=i:1")')
    expect(on.cfg).toMatch(/^socket=udp:127\.0\.0\.1:5090$/m)
    expect(on.cfg).toContain('modparam("cfgutils", "shvset", "meet_number=s:7000")')
    expect(on.cfg).toContain('if ($shv(meet_on) != 1 || $si != "192.0.2.20") {')
    expect(on.cfg).toContain('$ru = "sip:7000@192.0.2.20:5080";')
    expect(on.cfg).toContain(`$var(meet_ha1) = "${createHash('md5').update(`livekit:sip.example.test:${password}`).digest('hex')}";`)
    expect(on.cfg).not.toContain(password)
    for (const [env, message] of [
      [{ MEET_SIP: '192.0.2.20:5080' }, /MEET_SIP_PASSWORD/],
      [{ MEET_SIP: '192.0.2.20:5080', MEET_SIP_PASSWORD: 'short' }, /12 characters/],
      [{ MEET_SIP: 'livekit.example.test:5080', MEET_SIP_PASSWORD: password }, /IPv4 address and port/],
      [{ MEET_SIP: '192.0.2.20', MEET_SIP_PASSWORD: password }, /IPv4 address and port/],
      [{ MEET_PORT: '5060' }, /socket of its own/],
      [{ MEET_LISTEN_IP: '0.0.0.0' }, /MEET_LISTEN_IP/],
      [{ MEET_NUMBER: '0800' }, /MEET_NUMBER/],
      [{ MEET_SIP_USER: "livekit'" }, /MEET_SIP_USER/],
      ...([
        [{ MEET_PIN_TRIES: '0' }, /MEET_PIN_TRIES/],
        [{ MEET_PIN_TRIES: 'x' }, /MEET_PIN_TRIES/],
        [{ MEET_PIN_TRIES: '20', MEET_PIN_TRIES_ALL: '10' }, /MEET_PIN_TRIES_ALL/],
        [{ MEET_CALLS_PER_CALLER: '0' }, /MEET_CALLS_PER_CALLER/],
        [{ MEET_CALLS_PER_CALLER: '21' }, /MEET_CALLS_PER_CALLER/],
        [{ MEET_CALLS_PER_CALLER: '5', MEET_CALLS_ALL: '4' }, /MEET_CALLS_ALL/],
        [{ MEET_CALLS_ALL: '10001' }, /MEET_CALLS_ALL/],
        [{ MEET_MAX_CALL_SEC: '30' }, /MEET_MAX_CALL_SEC/],
        [{ MEET_MAX_CALL_SEC: '100000' }, /MEET_MAX_CALL_SEC/]
      ] as [Record<string, string>, RegExp][]).map(([e, m]) => [{ MEET_SIP: '192.0.2.20:5080', MEET_SIP_PASSWORD: password, ...e }, m])
    ] as [Record<string, string>, RegExp][]) {
      const { status, stderr } = render(env)
      expect(status, JSON.stringify(env)).toBe(1)
      expect(stderr).toMatch(message)
    }
    // Meet off: its settings are not read (second review n°10), whatever they say.
    const offWrong = render({ MEET_PIN_TRIES: 'x', MEET_PIN_TRIES_ALL: '0', MEET_CALLS_PER_CALLER: '0', MEET_CALLS_ALL: 'x', MEET_MAX_CALL_SEC: '30' })
    expect(offWrong.status, offWrong.stderr).toBe(0)
    expect(offWrong.cfg).toContain('modparam("cfgutils", "shvset", "meet_max_sec=i:7200")')
  })

  it("gives Wazo's Asterisk a socket of its own that hears its address only, takes no call from it, and reads no mailbox when Wazo is off (step 11a)", () => {
    const off = render()
    expect(off.status).toBe(0)
    expect(off.cfg).not.toMatch(/^socket=udp:[^\n]*:5095/m)
    expect(off.cfg).toContain('# None: Wazo is off (WAZO_SIP empty).')
    expect(off.cfg).toContain('modparam("cfgutils", "shvset", "wazo_on=i:0")')
    expect(off.cfg).toContain('$ru = "sip:" + $avp(dialled) + "@wazo.invalid";')
    const on = render({ WAZO_SIP: '192.0.2.30:5100' })
    expect(on.status, on.stderr).toBe(0)
    expect(on.cfg).toContain('modparam("cfgutils", "shvset", "wazo_on=i:1")')
    expect(on.cfg).toMatch(/^socket=udp:127\.0\.0\.1:5095$/m)
    expect(on.cfg).toContain('if ($shv(wazo_on) != 1 || $si != "192.0.2.30") {')
    expect(on.cfg).toContain('$ru = "sip:" + $avp(dialled) + "@192.0.2.30:5100";')
    expect(on.cfg).toContain('$socket_out = "udp:127.0.0.1:5095";')
    // Nothing it sends out of a call to a mailbox goes anywhere: keepalives answered, the rest refused.
    const initial = on.cfg.slice(on.cfg.indexOf('if ($var(wazo) == 1) {\n\t\tif (is_method("ACK"))'))
    expect(initial.slice(0, initial.indexOf('\n\t}\n'))).toContain('send_reply(403, "Forbidden");')
    // In a call, its side is the mailbox's (upstream), only that side speaks from there, and it never transfers.
    expect(on.cfg).toContain('if ($dlg_val(voicemail) == "1" && is_direction("upstream"))')
    expect(on.cfg).toContain('if ($var(from_wazo) != $var(wazo) || ($dlg_val(voicemail) == "1" && is_method("REFER"))) {')
    // Which mailbox and greeting: only this script says it (removed from what a phone or the operator sends), in each
    // of the two routes the calls come in by, before anything else reads them: within the route itself, not in a route
    // written after it.
    const routeBody = (header: string) => {
      const at = on.cfg.indexOf(`\n${header} {\n`)
      expect(at, header).toBeGreaterThan(0)
      const end = on.cfg.slice(at + 1).search(/\n(route|failure_route|onreply_route|branch_route|local_route|startup_route|timer_route|event_route|error_route)(\[[^\]]*\])? \{\n/)
      return on.cfg.slice(at, at + 1 + end)
    }
    for (const header of ['route', 'route[trunk_in]']) {
      const body = routeBody(header)
      for (const name of ['X-Twake-Mailbox', 'X-Twake-Voicemail']) {
        expect(body.match(new RegExp(`\\n\\tremove_hf\\("${name}"\\);\\n`, 'g')), `${header} ${name}`).toHaveLength(1)
        // Before the first of the routes it calls that could take the call to a mailbox.
        const removed = body.indexOf(`remove_hf("${name}");`)
        const first = body.search(/route\((rules_next|meet_call|did_fallback|voicemail)/)
        if (first >= 0) expect(removed, `${header} ${name}`).toBeLessThan(first)
      }
    }
    // The mailbox is read with the first rules only while Wazo is on and the table is there (route[read_failed]).
    expect(on.cfg).toContain(`$var(vm_col) = ", (SELECT v.mailbox FROM voicemail_boxes v WHERE v.extension = '" + $rU + "' AND v.mailbox ~ '^[0-9]{1,40}@[A-Za-z0-9_-]{1,79}$')";`)
    expect(on.cfg).toContain('if ($shv(wazo_on) == 1 && $shv(no11_until) <= $Ts) {')
    expect(on.cfg).toContain('if ($avp(q11) == 1 && route(table_11_missing)) {\n\t\t$shv(no11_until) = $Ts + 30;')
    // Twelve SIP processes with Wazo's socket for the connections the database must take.
    expect(readFileSync(join(dir, 'entrypoint.sh'), 'utf8')).toContain('sip_processes=$((10 + 2 * WAZO_ON))')
    for (const [env, message] of [
      [{ WAZO_SIP: 'wazo.example.test:5100' }, /WAZO_SIP must be the IPv4 address and port/],
      [{ WAZO_SIP: '192.0.2.30' }, /WAZO_SIP must be the IPv4 address and port/],
      [{ WAZO_SIP: '192.0.2.30:99999' }, /WAZO_SIP must be the IPv4 address and port/],
      [{ WAZO_SIP: '0.0.0.0:5100' }, /WAZO_SIP must be the IPv4 address and port/],
      [{ WAZO_PORT: '5060' }, /socket of its own/],
      [{ WAZO_PORT: '5090' }, /socket of its own/],
      [{ WAZO_PORT: 'x' }, /WAZO_PORT/],
      [{ WAZO_LISTEN_IP: '0.0.0.0' }, /WAZO_LISTEN_IP/]
    ] as [Record<string, string>, RegExp][]) {
      const { status, stderr } = render(env)
      expect(status, JSON.stringify(env)).toBe(1)
      expect(stderr).toMatch(message)
    }
  })

  it('sends a call nothing else takes to the mailbox of the extension dialled, after the forwards, and gives the original refusal when it does not answer (step 11a)', () => {
    const { cfg } = render({ WAZO_SIP: '192.0.2.30:5100' })
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    const vm = section('route[voicemail]', 'route[voicemail_undo]')
    // Never for a ring group, a room's or a conference's call, a Replaces, a call to oneself or one cancelled.
    expect(vm).toContain('if ($shv(wazo_on) != 1 || $shv(wazo_mute_until) > $Ts || $avp(vm_box) == NULL || $avp(vm_used) != NULL || $avp(group) != NULL || $dlg_val(meet) != NULL || $avp(conference) != NULL)')
    expect(vm).toContain('if (is_present_hf("Replaces") || t_was_cancelled() || $avp(dialled) == $avp(caller) || !($avp(dialled) =~ "^[0-9]{1,40}$"))')
    // Once per call; the mailbox and the greeting in headers only this script writes; acc's callee the extension dialled.
    expect(vm.indexOf('$avp(vm_used) = 1;')).toBeLessThan(vm.indexOf('t_relay()'))
    expect(vm).toContain('append_hf("X-Twake-Mailbox: $avp(vm_box)\\r\\n");')
    expect(vm).toContain('append_hf("X-Twake-Voicemail: $param(1)\\r\\n");')
    // Whatever a caller sent of them goes before they are written.
    for (const name of ['X-Twake-Mailbox', 'X-Twake-Voicemail']) {
      expect(vm.indexOf(`remove_hf("${name}");`), name).toBeGreaterThan(0)
      expect(vm.indexOf(`remove_hf("${name}");`), name).toBeLessThan(vm.indexOf(`append_hf("${name}: `))
    }
    // The headers appended are not undone by remove_hf: the undo does not pretend to.
    expect(section('route[voicemail_undo]', 'failure_route[voicemail_failed]')).not.toContain('remove_hf(')
    // Bounded as Meet is: pins on the invariants only (the behaviour of the caps is proven by the SIP e2e, against
    // OpenSIPS itself): the calls of a caller, of those with no number at a mailbox and at all of them, and of all at
    // the same time, and those of a caller to one mailbox in an hour, all read and counted under one lock; counted in
    // the hour only once the call has its place, counted out when the mailbox does not take it.
    expect(cfg).toContain('modparam("dialog", "profiles_with_value", "trunk_caller;meet_caller;vm_caller")')
    expect(cfg).toContain('modparam("dialog", "profiles_no_value", "trunk_out;trunk_emergency;meet_all;vm_all;vm_hidden")')
    const room = vm.slice(vm.indexOf('get_static_lock("vm_count");'), vm.indexOf('release_static_lock("vm_count");'))
    const order = ['get_profile_size("vm_caller"', 'get_profile_size("vm_all"', 'get_profile_size("vm_hidden"', 'cache_add("local", "vm:h:', 'set_dlg_profile("vm_caller"', 'set_dlg_profile("vm_all")', 'set_dlg_profile("vm_hidden")']
    for (const [i, step] of order.entries()) {
      expect(room.indexOf(step), step).toBeGreaterThan(0)
      if (i) expect(room.indexOf(order[i - 1]!), step).toBeLessThan(room.indexOf(step))
    }
    expect(room).toContain('$var(vm_nobody) < $shv(vm_hidden_all)')
    expect(vm.split('cache_add(').length).toBe(2)
    expect(vm.indexOf('release_static_lock("vm_count");')).toBeLessThan(vm.indexOf('t_relay()'))
    // Counted by a keyed print of the number, never the number (a profile is written in `dialog`, shown by the MI); by
    // the person's mailbox, whatever extension reaches it.
    expect(vm).toContain('{s.sha256_hmac,$shv(vm_key)}')
    expect(vm).not.toMatch(/\$var\(vm_who\) = \$avp\((caller|vm_real)\)/)
    expect(room).toContain('"vm:h:$var(vm_who):$avp(vm_box)"')
    expect(vm).not.toContain(':$avp(dialled)", 1, 3600')
    expect(cfg.split('$avp(vm_real)').length).toBe(6)
    // The administrators told of each cap reached, once per 10 minutes.
    for (const param of ['hidden-hour', 'hidden-calls', 'hidden-all', 'calls-all']) expect(vm, param).toContain(`route(voicemail_alert, "${param}", `)
    const vmAlert = section('route[voicemail_alert]', 'failure_route[voicemail_failed]')
    expect(vmAlert).toContain('cache_add("local", "$var(told_key)", 1, 600, $var(told));')
    expect(vmAlert).toContain('raise_event("E_TWAKEPHONE_VMCAP", $avp(ev_attr), $avp(ev_val));')
    // Counted out of the hour when rtpengine fails, and in the undo (Asterisk silent, refused, t_relay failed), once,
    // under the lock; a key gone meanwhile removed, never left at -1.
    expect(vm).toContain('failed\\n");\n\t\t\troute(voicemail_unhour);\n\t\t\treturn(-1);')
    expect(section('route[voicemail_undo]', 'failure_route[voicemail_failed]')).toContain('route[voicemail_undo] {\n\troute(voicemail_unhour);')
    const unhour = section('route[voicemail_unhour]', 'failure_route[voicemail_failed]')
    expect(unhour.indexOf('get_static_lock("vm_count");')).toBeLessThan(unhour.indexOf('cache_sub('))
    expect(unhour.indexOf('cache_remove(')).toBeLessThan(unhour.indexOf('release_static_lock("vm_count");'))
    // The caps and the bound in shared variables, for the calls to come (MI shv_set) and for the Gateway (shv_get).
    expect(cfg).toContain('modparam("cfgutils", "shvset", "vm_per_caller=i:2")')
    expect(cfg).toContain('modparam("cfgutils", "shvset", "vm_hidden=i:5")')
    expect(cfg).toContain('modparam("cfgutils", "shvset", "vm_hidden_all=i:10")')
    expect(cfg).toMatch(/modparam\("cfgutils", "shvset", "vm_key=s:[0-9a-f]{32}"\)/)
    expect(cfg).toContain('modparam("cfgutils", "shvset", "vm_calls_all=i:30")')
    expect(cfg).toContain('modparam("cfgutils", "shvset", "vm_per_hour=i:10")')
    expect(cfg).toContain('modparam("cfgutils", "shvset", "vm_max_sec=i:300")')
    const capped = render({ WAZO_SIP: '192.0.2.30:5100', VOICEMAIL_CALLS_PER_CALLER: '1', VOICEMAIL_CALLS_HIDDEN: '2', VOICEMAIL_CALLS_ALL: '5', VOICEMAIL_CALLS_PER_HOUR: '3' }).cfg
    // The share of those with no number follows VOICEMAIL_CALLS_ALL when it is not given, or given empty as the Compose
    // stack passes it: OpenSIPS starts with VOICEMAIL_CALLS_ALL alone lowered.
    for (const hiddenAll of [{}, { VOICEMAIL_CALLS_HIDDEN_ALL: '' }] as Record<string, string>[]) {
      const twelve = render({ WAZO_SIP: '192.0.2.30:5100', VOICEMAIL_CALLS_ALL: '12', ...hiddenAll })
      expect([twelve.status, twelve.stderr]).toEqual([0, ''])
      expect(twelve.cfg).toContain('modparam("cfgutils", "shvset", "vm_hidden_all=i:4")')
    }
    expect(readFileSync(join(dir, '..', 'docker-compose.sip.yml'), 'utf8')).toContain('VOICEMAIL_CALLS_HIDDEN_ALL: ${VOICEMAIL_CALLS_HIDDEN_ALL:-}\n')
    // The key of the prints drawn at each start: two starts, two keys.
    const keyOf = (rendered: string) => /"vm_key=s:([0-9a-f]{32})"/.exec(rendered)?.[1]
    const keys = [keyOf(render({ WAZO_SIP: '192.0.2.30:5100' }).cfg), keyOf(render({ WAZO_SIP: '192.0.2.30:5100' }).cfg)]
    expect(keys.every(k => k !== undefined)).toBe(true)
    expect(keys[0]).not.toBe(keys[1])
    // Their share at 0 closes the mailboxes to them without an alert at each call.
    expect(vm).toContain('if ($var(vm_nobody) >= $shv(vm_hidden_all)) {\n\t\t\t\t\tif ($shv(vm_hidden_all) > 0)\n\t\t\t\t\t\troute(voicemail_alert, "hidden-all", ')
    for (const shv of ['vm_per_caller=i:1', 'vm_hidden=i:2', 'vm_hidden_all=i:1', 'vm_calls_all=i:5', 'vm_per_hour=i:3']) expect(capped).toContain(`modparam("cfgutils", "shvset", "${shv}")`)
    for (const [env, message] of [
      [{ VOICEMAIL_CALLS_PER_CALLER: '0' }, /VOICEMAIL_CALLS_PER_CALLER must be 1 to 20/],
      [{ VOICEMAIL_CALLS_PER_CALLER: '4', VOICEMAIL_CALLS_ALL: '3' }, /VOICEMAIL_CALLS_ALL must be VOICEMAIL_CALLS_PER_CALLER to 10000/],
      [{ VOICEMAIL_CALLS_HIDDEN: '0' }, /VOICEMAIL_CALLS_HIDDEN must be 1 to VOICEMAIL_CALLS_ALL/],
      [{ VOICEMAIL_CALLS_HIDDEN: '31' }, /VOICEMAIL_CALLS_HIDDEN must be 1 to VOICEMAIL_CALLS_ALL/],
      [{ VOICEMAIL_CALLS_PER_HOUR: 'x' }, /VOICEMAIL_CALLS_PER_HOUR must be a number/],
      [{ VOICEMAIL_CALLS_HIDDEN_ALL: '16' }, /VOICEMAIL_CALLS_HIDDEN_ALL must be 0 to half of VOICEMAIL_CALLS_ALL/],
      [{ VOICEMAIL_CALLS_HIDDEN_ALL: 'x' }, /VOICEMAIL_CALLS_HIDDEN_ALL must be a number/],
      // The variable that is wrong is the one named, not the share reckoned from it.
      [{ VOICEMAIL_CALLS_ALL: 'x' }, /^VOICEMAIL_CALLS_ALL must be a number of calls\n$/]
    ] as const)
      expect(render({ WAZO_SIP: '192.0.2.30:5100', ...env }).stderr).toMatch(message)
    // A caller from outside is said as such: the greeting never spells the extension to them.
    expect(vm).toContain('if ($dlg_val(trunk) == "caller")\n\t\tappend_hf("X-Twake-Voicemail: $param(1);caller=external\\r\\n");')
    // Bounded: VOICEMAIL_MAX_CALL_SEC (300 s by default); a mailbox that does not answer at once is left.
    expect(vm).toContain('if ($DLG_timeout == NULL || $DLG_timeout > $shv(vm_max_sec))\n\t\t$DLG_timeout = $shv(vm_max_sec);')
    expect(vm).toContain('$T_fr_timeout = 2;')
    expect(render({ WAZO_SIP: '192.0.2.30:5100', VOICEMAIL_MAX_CALL_SEC: '120' }).cfg).toContain('modparam("cfgutils", "shvset", "vm_max_sec=i:120")')
    expect(render({ WAZO_SIP: '192.0.2.30:5100', VOICEMAIL_MAX_CALL_SEC: '10' }).stderr).toMatch(/VOICEMAIL_MAX_CALL_SEC must be 30 to 3600/)
    // Given back as it was when the mailbox does not answer: the way the call went, and its lifetime.
    expect(vm.indexOf('$avp(vm_via) = $acc_extra(via);')).toBeLessThan(vm.indexOf('$acc_extra(via) = "voicemail";'))
    const undo = section('route[voicemail_undo]', 'failure_route[voicemail_failed]')
    expect(undo).toContain('if ($avp(vm_via) != NULL)\n\t\t$acc_extra(via) = $avp(vm_via);')
    expect(undo).toContain('$DLG_timeout = $avp(vm_timeout);')
    expect(vm).toContain('$acc_extra(callee) = $avp(dialled);')
    expect(vm).toContain('$acc_extra(via) = "voicemail";')
    expect(vm).toContain('t_on_failure("voicemail_failed");')
    // No route[rtp_offer] (route[sides] is not for a failure route), no reply of its own.
    expect(vm).not.toContain('route(rtp_offer)')
    expect(vm).not.toMatch(/send_reply|t_reply/)
    // Every place a call ends unanswered asks it first: "do not disturb", nobody to ring, no window reached, and the
    // failure route after the forwards and the direct number's fallback, busy (486, 600, 603) with its own greeting.
    expect(cfg.match(/route\(voicemail, "unavailable"\);/g)).toHaveLength(5)
    expect(cfg.match(/route\(voicemail, "busy"\);/g)).toHaveLength(1)
    const dnd = section('route[dnd_reply]', 'route[forwarded]')
    expect(dnd.indexOf('route(voicemail, "unavailable");')).toBeGreaterThan(0)
    expect(dnd.indexOf('route(voicemail, "unavailable");')).toBeLessThan(dnd.indexOf('raise_event('))
    const failure = cfg.slice(cfg.indexOf('\nfailure_route[call_failed] {'))
    expect(failure.indexOf('route(voicemail, "busy");')).toBeGreaterThan(failure.indexOf('route(did_fallback, "not answered", $var(code));'))
    expect(failure).toContain('if (t_check_status("486|600|603") && $var(rang_out) == 0)\n\t\t\troute(voicemail, "busy");')
    // Not answered: everything undone, the same refusal and missed call as without it ("do not disturb": its own).
    const failed = cfg.slice(cfg.indexOf('\nfailure_route[voicemail_failed] {'), cfg.indexOf('\nlocal_route {'))
    expect(failed.indexOf('route(voicemail_undo);')).toBeGreaterThan(0)
    expect(failed.indexOf('route(dnd_reply);')).toBeGreaterThan(failed.indexOf('if ($avp(vm_then) == "dnd") {'))
    expect(failed).toContain('route(account_missed);\n\tt_reply($avp(vm_code), "$avp(vm_reason)");')
    // The caller's window is told the mailbox answered: a header no phone can send it, never sent to the operator.
    const rtpReply = section('onreply_route[rtp]', 'route[event_attrs]')
    expect(rtpReply.indexOf('remove_hf("Twake-Voicemail");')).toBeGreaterThan(0)
    expect(rtpReply.indexOf('remove_hf("Twake-Voicemail");')).toBeLessThan(rtpReply.indexOf('append_hf("Twake-Voicemail: 1'))
    expect(rtpReply).toContain('if ($rs >= 200 && $rs < 300 && $dlg_val(trunk) != "caller")\n\t\t\tappend_hf("Twake-Voicemail: 1\\r\\n");')
    // Never anywhere else: the operator never hears it.
    expect(cfg.match(/append_hf\("Twake-Voicemail/g)).toHaveLength(1)
    expect(cfg.match(/append_to_reply\("Twake-Voicemail/g)).toBeNull()
    // Nor what answered: the software of the mailbox, or that it is one.
    const mailboxReply = rtpReply.slice(rtpReply.indexOf('if ($avp(voicemail) != NULL) {'))
    expect(mailboxReply.indexOf('remove_hf("Server");')).toBeGreaterThan(0)
    expect(mailboxReply.indexOf('remove_hf("User-Agent");')).toBeGreaterThan(0)
    expect(mailboxReply.indexOf('remove_hf("Server");')).toBeLessThan(mailboxReply.indexOf('exit;'))
    // Asterisk heard nothing from: the mailboxes left out 30 s, before the refusal is given back.
    expect(cfg).toContain('modparam("cfgutils", "shvset", "wazo_mute_until=i:0")')
    expect(failed).toContain('if (t_check_status("408") && t_local_replied("all")) {\n\t\t$shv(wazo_mute_until) = $Ts + 30;')
    expect(failed.indexOf('$shv(wazo_mute_until) = $Ts + 30;')).toBeLessThan(failed.indexOf('route(voicemail_undo);'))
    // A direct number whose fallback is a group nobody of which answered: the mailbox of the
    // extension the number rings, the group set aside while it is tried; not answered, the group's refusal.
    const group = failure.slice(failure.indexOf('route(did_fallback, "the group did not answer", "480");'), failure.indexOf('route(group_missed, "480 Temporarily Unavailable");'))
    expect(group).toContain('if ($avp(fb_used) != NULL && $avp(vm_box) != NULL) {')
    expect(group.indexOf('$(avp(group)[*]) = NULL;')).toBeLessThan(group.indexOf('route(voicemail, "unavailable");'))
    expect(group.indexOf('$avp(group) = $avp(vm_group);')).toBeGreaterThan(group.indexOf('route(voicemail, "unavailable");'))
    expect(failed).toContain('if ($avp(vm_then) == "group") {\n\t\t$avp(group) = $avp(vm_group);\n\t\trtpengine_delete();\n\t\troute(group_missed, "480 Temporarily Unavailable");\n\t\tt_reply(480, "Temporarily Unavailable");')
    // Answered: told once, as the mailbox's, never as the callee's answer.
    const onreply = cfg.slice(cfg.indexOf('\nonreply_route[rtp] {'), cfg.indexOf('\nroute[event_attrs] {'))
    const told = onreply.indexOf('if ($avp(voicemail) != NULL) {')
    expect(told).toBeGreaterThan(onreply.indexOf('route(rtp_answer);'))
    expect(told).toBeLessThan(onreply.indexOf('if ($avp(callee) != NULL) {'))
    expect(onreply).toContain('raise_event("E_TWAKEPHONE_VOICEMAIL", $avp(ev_attr), $avp(ev_val));')
  })

  it('takes a room call only with the Gateway grant of that very call: used once, for its person and number (step 8, review n°1)', () => {
    const { cfg } = render({ SIP_DOMAIN: 'sip.example.test', MEET_SIP: '192.0.2.20:5080', MEET_SIP_PASSWORD: 'not-a-real-secret-0' })
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    // Read once LiveKit SIP authenticated, never passed on.
    expect(cfg).toContain('$avp(meet_grant) = $hdr(X-Twake-Grant);')
    expect(cfg).toContain('remove_hf("X-Twake-Grant");')
    const source = section('route[meet_source]', 'route[meet_source_loaded]')
    // Only the characters of a grant, of a number, of a tag and of a Call-ID get into the query; anything else is
    // refused before it.
    expect(source).toContain('if (!($avp(meet_grant) =~ "^[0-9a-f]{32}$") || !($rU =~ "^[+]?[0-9*#]{2,20}$") || !($ft =~ "^[A-Za-z0-9._~!%*+-]{1,64}$") || !($ci =~ "^[A-Za-z0-9._~!%*+@:-]{1,200}$")) {')
    expect(source.indexOf('t_reply(403, "Not Granted");')).toBeLessThan(source.indexOf('async(sql_query_one('))
    // Marked with the call that takes it as it is read (review 8b, n°3: its From tag and Call-ID, for the Gateway to
    // compare with its own), kept 10 minutes for that: used once, before its expiry, for this person and number only.
    expect(source).toContain(`"UPDATE dial_out_grants g SET used_by = '" + $ft + "', used_call = '" + $ci + "', expires_at = now() + interval '10 minutes' WHERE g.token = '" + $avp(meet_grant) + "' AND g.used_by IS NULL AND g.extension = '" + $fU + "' AND g.number = '" + $rU + "' AND g.expires_at > now() AND EXISTS (SELECT 1 FROM subscriber s WHERE s.username = g.extension) RETURNING 1, coalesce(g.replaces, ''), coalesce(g.join_token, ''), coalesce(g.room, '')"`)
    expect(cfg).not.toContain('DELETE FROM dial_out_grants')
    const loaded = section('route[meet_source_loaded]', 'route[meet_call]')
    expect(loaded).toContain('if ($var(meet_rc) == -2) {')
    expect(loaded.indexOf('append_to_reply("Twake-Call-Refused: not-granted\\r\\n");')).toBeLessThan(loaded.indexOf('route(trunk_out);'))
    // The CDR says the call came from a room.
    expect(cfg).toContain('$acc_extra(via) = "meet";')
  })

  it('makes the reads a call cannot go without again, synchronously, when OpenSIPS dropped them (past db_max_async_connections: -1), and never a read that changes what it reads', () => {
    const { cfg } = render({ MEET_SIP: '192.0.2.20:5080', MEET_SIP_PASSWORD: 'not-a-real-secret-0' })
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    // The direct number of a call from the operator: a burst of them past the cap answered 404 (the CI, step 8a).
    expect(section('route[trunk_in]', 'route[inbound_number]')).toContain('$avp(did_query) = $var(did_query);\n\troute(read_sent);\n\tasync(sql_query_one("$var(did_query)", "$avp(did_target);')
    const din = section('route[trunk_in_loaded]', 'route[did_fallback]')
    expect(din).toContain('if ($var(did_rc) == -1 && route(read_again)) {\n\t\tsql_query_one("$avp(did_query)", "$avp(did_target);$avp(t_codecs);$avp(fb_target);$avp(fb_kind);$avp(fb_members);$avp(did_assigned)");\n\t\t$var(did_rc) = $rc;\n\t}')
    expect(din.indexOf('route(read_again)')).toBeLessThan(din.indexOf('t_reply(404, "Not Found");'))
    // The trunk of a call to the operator, likewise, before it is told there is none.
    expect(section('route[trunk_out]', 'route[trunk_out_loaded]')).toContain('$avp(trunk_query) = $var(trunk_query);\n\troute(read_sent);\n\tasync(sql_query_one("$var(trunk_query)",')
    const tout = section('route[trunk_out_loaded]', 'route[trunk_out_send]')
    expect(tout).toContain('if ($var(trunk_rc) == -1 && route(read_again)) {\n\t\tsql_query_one("$avp(trunk_query)", "$avp(t_setid);')
    expect(tout.indexOf('route(read_again)')).toBeLessThan(tout.indexOf('if ($var(trunk_rc) == -2) {'))
    // Only a read that failed at once (review 8b, n°5): one that failed after half of RULES_QUERY_TIMEOUT_MS is a slow
    // database, not made again. The time it went, in milliseconds modulo 1000 s (32-bit integers).
    expect(section('route[read_sent]', 'route[read_again]')).toContain('$avp(q_sent) = ($Ts % 1000) * 1000 + ($Tsm / 1000);')
    const again = section('route[read_again]', 'route[read_failed]')
    expect(again).toContain('$var(q_spent) = ($var(q_now) - $avp(q_sent) + 1000000) % 1000000;')
    // No arithmetic in a condition (OpenSIPS refuses it): twice the time in a variable of its own.
    expect(again).toContain('$var(q_twice) = $var(q_spent) * 2;\n\tif ($var(q_twice) >= 1000) {')
    expect(again.indexOf('if ($avp(q_sent) == NULL) {')).toBeLessThan(again.indexOf('$var(q_now)'))
    expect(again.indexOf('return(-1);')).toBeLessThan(again.indexOf('return(1);'))
    expect(render({ RULES_QUERY_TIMEOUT_MS: '600' }).cfg).toContain('if ($var(q_twice) >= 600) {')
    // twake_outbound() reserves minutes, a grant is taken once: neither is made twice. What twake_outbound() may have
    // reserved for a call it then refuses goes (review 8b, n°5).
    const outbound = section('route[outbound_loaded]', 'route[outbound_rights]')
    expect(outbound).not.toContain('read_again')
    expect(outbound).toContain('\t\t$var(o_key) = $(ci{s.md5});\n\t\tsql_query("DELETE FROM outbound_reservations WHERE call_key = \'$var(o_key)\'");')
    expect(outbound.indexOf('DELETE FROM outbound_reservations')).toBeLessThan(outbound.indexOf('t_reply(503, "Call Rules Unavailable");'))
    expect(section('route[meet_source_loaded]', 'route[conference_leg]')).not.toContain('read_again')
    expect(cfg.match(/route\(read_again\)/g)).toHaveLength(2)
    expect(cfg.match(/route\(read_sent\)/g)).toHaveLength(2)
  })

  it('sizes the connections of the asynchronous reads (DB_MAX_ASYNC_CONNECTIONS, review 8b, n°5): 8 by default, 1 to 32', () => {
    expect(render().cfg).toContain('\ndb_max_async_connections=8\n')
    expect(render({ DB_MAX_ASYNC_CONNECTIONS: '1' }).cfg).toContain('\ndb_max_async_connections=1\n')
    for (const value of ['0', '33', 'x', '-1']) {
      const { status, stderr } = render({ DB_MAX_ASYNC_CONNECTIONS: value })
      expect(status, value).not.toBe(0)
      expect(stderr).toMatch(/DB_MAX_ASYNC_CONNECTIONS/)
    }
  })

  it('says when the asynchronous reads may open more connections than the database takes (second review 8b, n°9); OpenSIPS starts all the same', () => {
    // A database that takes 200 connections, as on this stack.
    const bin = join(tmp, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'psql'), '#!/bin/sh\ncase "$*" in *max_connections*) echo 200 ;; esac\nexit 0\n')
    chmodSync(join(bin, 'psql'), 0o755)
    writeFileSync(join(tmp, 'trunk.sql'), '')
    const env = { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, TRUNK_SQL: join(tmp, 'trunk.sql') }
    const wide = render({ ...env, DB_MAX_ASYNC_CONNECTIONS: '32' })
    expect(wide.status).toBe(0)
    expect(wide.stderr).toContain('WARNING: DB_MAX_ASYNC_CONNECTIONS=32 may open about 350 connections to the database, which takes 200 (max_connections)')
    for (const value of ['8', '16']) expect(render({ ...env, DB_MAX_ASYNC_CONNECTIONS: value }).stderr, value).not.toContain('WARNING')
  })

  it("sends a conference's room call (step 8b) where its grant says, as it says, and nowhere else; no phone writes what only this script does", () => {
    const { cfg } = render({ SIP_DOMAIN: 'sip.example.test', MEET_SIP: '192.0.2.20:5080', MEET_SIP_PASSWORD: 'not-a-real-secret-0' })
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    // The grant's conference columns, read with it into AVPs of their own.
    expect(section('route[meet_source]', 'route[meet_source_loaded]')).toContain('async(sql_query_one("$var(meet_query)", "$avp(meet_known);$avp(meet_replaces);$avp(meet_join);$avp(meet_room)"), meet_source_loaded);')
    const loaded = section('route[meet_source_loaded]', 'route[conference_leg]')
    const at = (text: string, within = loaded) => {
      const i = within.indexOf(text)
      expect(i, text).toBeGreaterThan(0)
      return i
    }
    // Once the grant is taken, before any trunk or rule; a room's other calls say a room calls.
    expect(at('route(conference_leg);')).toBeGreaterThan(at('t_reply(503, "Service Unavailable");'))
    expect(at('route(conference_leg);')).toBeLessThan(at('route(trunk_out);'))
    expect(at('route(trunk_out);')).toBeLessThan(at('append_hf("Twake-Room: meet\\r\\n");'))
    expect(at('append_hf("Twake-Room: meet\\r\\n");')).toBeLessThan(at('route(rules_next);'))
    // A call of a conference's room to a third participant says so, and which room (review 8b, n°2).
    // A call of the conference as the others' are (second review 8b, n°8): its CDR and its events say conference.
    expect(loaded).toContain('if ($avp(meet_room) =~ "^twake-call-[0-9a-f]{16}$") {\n\t\tappend_hf("Twake-Room: conference\\r\\n");\n\t\tappend_hf("Twake-Conference: $avp(meet_room)\\r\\n");\n\t\t$avp(conference) = 1;\n\t\t$acc_extra(via) = "conference";\n\t} else\n\t\tappend_hf("Twake-Room: meet\\r\\n");')
    const leg = section('route[conference_leg]', 'route[meet_call]')
    // Never the public network; the header of its grant, written by this script; then the phones of the extension.
    expect(at('t_reply(403, "Not Granted");', leg)).toBeLessThan(at('append_hf("Replaces: $avp(meet_replaces)\\r\\n");', leg))
    expect(leg).toContain('\t} else\n\t\tappend_hf("Twake-Join: $avp(meet_join)\\r\\n");\n\tappend_hf("Twake-Room: conference\\r\\n");\n\tif ($avp(meet_room) != "")\n\t\tappend_hf("Twake-Conference: $avp(meet_room)\\r\\n");')
    // The phone takes it in the place of the call or refuses it (420), never rings it (review 8b, n°14).
    expect(leg).toContain('\t\tappend_hf("Replaces: $avp(meet_replaces)\\r\\n");\n\t\tappend_hf("Require: replaces\\r\\n");')
    // What the grant says goes into headers only as the Gateway writes it (review 8b, n°15), before any of them.
    expect(at('$avp(meet_replaces) =~ "^[A-Za-z0-9._~!%*+@:-]{1,200};to-tag=[A-Za-z0-9._~!%*+-]{1,50};from-tag=[A-Za-z0-9._~!%*+-]{1,50}$"', leg)).toBeLessThan(at('append_hf("Replaces:', leg))
    expect(leg).toContain('$avp(meet_join) =~ "^[0-9a-f]{32}$"')
    expect(leg).toContain('$avp(meet_room) =~ "^twake-call-[0-9a-f]{16}$"')
    expect(leg).toContain('$acc_extra(via) = "conference";')
    expect(at('if (!lookup("location")) {', leg)).toBeLessThan(at('route(names_next);', leg))
    // No rules, no forward, no group, no trunk, no wake: the very phones of that extension.
    expect(leg.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')).not.toMatch(/\brules_|\bforward|\bgroup|\btrunk_out|\bwake/)
    // From the phones and the operator, before anything: only this script writes them.
    expect(cfg.match(/\tremove_hf\("Twake-Join"\);/g)).toHaveLength(2)
    expect(cfg.match(/\tremove_hf\("Twake-Room"\);/g)).toHaveLength(2)
    expect(cfg.match(/\tremove_hf\("Twake-Conference"\);/g)).toHaveLength(2)
    const main = cfg.slice(0, cfg.indexOf('\nroute[meet_source] {'))
    expect(main.indexOf('remove_hf("Twake-Join");')).toBeLessThan(main.indexOf('route(meet_source);'))
    // The tag of the phone that answered stays with the dialog; the events say which call is a conference's.
    expect(cfg).toContain('$avp(answered) = 1;\n\t\t\t# The tag of the phone that answered: a room\'s call that takes the place of this one names it (step 8b).\n\t\t\t$dlg_val(callee_tag) = $tt;')
    expect(section('route[event_attrs]', 'route[probe_event]')).toContain('if ($avp(conference) != NULL) {\n\t\t$avp(ev_attr) = "conference";\n\t\t$avp(ev_val) = "1";\n\t}')
  })

  it('counts every call LiveKit SIP answers as a try of its caller, when it comes, caps the calls at the same time, tells the administrators, and bounds every call with LiveKit SIP (step 8, third review n°1, n°2, n°3)', () => {
    const { cfg } = render({ MEET_SIP: '192.0.2.20:5080', MEET_SIP_PASSWORD: 'not-a-real-secret-0', MEET_PIN_TRIES: '4', MEET_PIN_TRIES_ALL: '50', MEET_CALLS_PER_CALLER: '3', MEET_CALLS_ALL: '40', MEET_MAX_CALL_SEC: '1800' })
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    const call = section('route[meet_call]', 'failure_route[meet_failed]')
    const at = (text: string) => {
      const i = call.indexOf(text)
      expect(i, text).toBeGreaterThan(0)
      return i
    }
    // The calls at the same time, this one counted in, under a lock; those who hide their number under the cap of all.
    expect(call).toContain('$var(pin_cap) = 4;\n\t$var(m_cap) = 3;\n\tif ($var(pin_who) == "anonymous" || $var(pin_who) == "other") {\n\t\t$var(pin_cap) = 50;\n\t\t$var(m_cap) = 40;\n\t}')
    expect(call).toContain('get_static_lock("meet_count");\n\tset_dlg_profile("meet_caller", "$var(pin_who)");\n\tset_dlg_profile("meet_all");\n\tget_profile_size("meet_caller", "$var(pin_who)", $var(m_mine));\n\tget_profile_size("meet_all", , $var(m_all));\n\trelease_static_lock("meet_count");')
    expect(call).toContain('if ($var(m_all) > 40) {')
    expect(at('t_reply(503, "Service Unavailable");')).toBeGreaterThan(at('route(meet_alert, "calls", $var(m_all), 40);'))
    expect(call).toContain('if ($var(m_mine) > $var(m_cap)) {')
    // A try counted when the call comes (whatever its length), before the refusal: calls at once count each other.
    expect(call).toContain('cache_add("local", "pin:c:$var(pin_who)", 1, 600, $var(pin_n));\n\tif ($var(pin_n) > $var(pin_cap)) {')
    expect(at('t_reply(486, "Busy Here");')).toBeLessThan(at('cache_add("local", "pin:c:'))
    expect(at('t_reply(403, "Too Many Tries");')).toBeLessThan(at('$ru = "sip:8000@192.0.2.20:5080";'))
    // Those of all: the alert at the threshold (not past it: those who hide their number are refused past it).
    expect(call).toContain('cache_add("local", "pin:all", 1, 600, $var(pin_all));\n\tif ($var(pin_all) >= 50)\n\t\troute(meet_alert, "pin-tries", $var(pin_all), 50);')
    // Given back when LiveKit SIP does not answer.
    const failed = section('failure_route[meet_failed]', 'route[meet_alert]')
    expect(failed).toContain('cache_sub("local", "pin:c:$avp(pin_who)", 1, 600, $var(left));')
    expect(failed).toContain('cache_sub("local", "pin:all", 1, 600, $var(left));')
    // Told once per 10 minutes for each; nobody refused there.
    const alert = section('route[meet_alert]', 'route[outbound_policy]')
    expect(alert).toContain('cache_add("local", "pin:told:$param(1)", 1, 600, $var(told));\n\tif ($var(told) != 1)\n\t\treturn(1);')
    expect(alert).toContain('raise_event("E_TWAKEPHONE_PIN", $avp(ev_attr), $avp(ev_val));')
    expect(alert).not.toContain('t_reply(')
    // No count at a BYE any more (a wrong PIN typed late was none).
    expect(cfg).not.toContain('route(meet_bye)')
    // Every call to it lasts MEET_MAX_CALL_SEC at most, then BYE to both sides: from a phone too (B; the operator's
    // calls have it already), and the rooms' calls; the e2e shortens it through the MI.
    expect(cfg).toContain('modparam("cfgutils", "shvset", "meet_max_sec=i:1800")')
    expect(call).toContain('if ($dlg_val(trunk) == NULL)\n\t\tcreate_dialog("B");\n\tif ($DLG_timeout > $shv(meet_max_sec))\n\t\t$DLG_timeout = $shv(meet_max_sec);')
    expect(cfg).toContain('if ($dlg_val(meet) == "caller" && $DLG_timeout > $shv(meet_max_sec))\n\t\t$DLG_timeout = $shv(meet_max_sec);')
    expect(cfg).toContain('modparam("dialog", "profiles_with_value", "trunk_caller;meet_caller;vm_caller")')
    // The defaults.
    const defaults = render({ MEET_SIP: '192.0.2.20:5080', MEET_SIP_PASSWORD: 'not-a-real-secret-0' }).cfg
    expect(defaults).toContain('$var(pin_cap) = 10;\n\t$var(m_cap) = 2;')
    expect(defaults).toContain('if ($var(m_all) > 100) {')
    expect(defaults).toContain('if ($var(pin_all) >= 300)')
    expect(defaults).toContain('modparam("cfgutils", "shvset", "meet_max_sec=i:7200")')
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
    // a ring group nobody of which has a window (route[group_hold]); the others are woken before their colleagues'
    // windows are relayed (route[group_wake]), and waited for after (route[group_wait]).
    expect(ring.slice(calling + 1).filter(l => l && !l.startsWith('#'))).toEqual([
      'if ($avp(wake) == 1)',
      'route(hold);',
      'if ($avp(group) != NULL && $avp(g_woken) > 0 && $avp(g_windows) == 0)',
      'route(group_hold);',
      '$var(group_wait) = 0;',
      'if ($avp(group) != NULL && $avp(g_woken) > 0) {',
      'route(group_wake);',
      '$var(group_wait) = 1;',
      '}',
      '$var(relay_request) = 1;',
      'route(relay_call);',
      '$var(relayed) = $rc;',
      'if ($var(relayed) == 3)',
      'route(wake_next);',
      'if ($var(relayed) == 4)',
      'route(group_dead);',
      'if ($var(group_wait) == 1)',
      'route(group_wait);',
      '}'
    ])
    // One offer per call: a forward after a failure sends the same one on.
    expect(ring[offer - 1]).toBe('if ($avp(rtp_on) == NULL && has_body_part("application/sdp"))')
    expect(section('route[rules_decide]', 'route[preload_query]')).toContain('if (lookup("location"))\n\t\treturn(2);')
    // Nobody to ring: the refusal goes through a transaction (acc sees it), announced just before.
    const unreachable = lines(section('route[unreachable]', 'route[forward_to]'))
    const missed = unreachable.indexOf('route(account_missed);')
    // A call from the operator rings the fallback of its direct number inside instead (step 6b, route[did_fallback]),
    // its offer made first.
    const steps = unreachable.filter(l => l && !l.startsWith('#'))
    const at = steps.indexOf('route(account_missed);')
    // Then the mailbox of the extension dialled (step 11a, route[voicemail]), which ends the script when it takes the call.
    expect(steps.slice(at - 12, at + 2)).toEqual([
      'route(calling);',
      'route(did_fallback_request, "unreachable", "480");',
      '$avp(vm_code) = 480;',
      '$avp(vm_reason) = "Temporarily Unavailable";',
      'if ($avp(fwd_hops) == 0 && $avp(dialled_unread) != 1) {',
      '$avp(vm_code) = 404;',
      '$avp(vm_reason) = "Not Found";',
      '}',
      '$avp(vm_then) = "reply";',
      'route(voicemail, "unavailable");',
      'if ($avp(rtp_on) != NULL)',
      'rtpengine_delete();',
      'route(account_missed);',
      't_reply($avp(vm_code), "$avp(vm_reason)");'
    ])
    expect(missed).toBeGreaterThan(0)
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

  it("touches no AVP of a call once its windows are relayed from the request route: their replies are handled meanwhile, in other processes, on the transaction's AVPs (a ring group's members woken before the relay)", () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    const code = (text: string) => text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    // onreply_route[rtp] works on the transaction's AVPs, under its reply lock; a request route works on the same list
    // once the transaction exists (t_newtran), resumed after a read (async) or not, without that lock.
    expect(cfg).toContain('modparam("tm", "onreply_avp_mode", 1)')
    const ring = code(section('route[ring_now]', 'route[cancelled]'))
    const relay = ring.indexOf('route(relay_call);')
    expect(relay).toBeGreaterThan(0)
    expect(ring.slice(relay + 1).filter(l => l.includes('avp('))).toEqual([])
    // Only a relay none of whose windows could be sent goes on with AVPs (route[wake_next], route[group_dead]): no
    // window replies. One that sent returns at once.
    const relayCall = code(section('route[relay_call]', 'route[relay_failed]'))
    const sent = relayCall.indexOf('if (!t_relay())')
    expect(relayCall.slice(sent, sent + 4)).toEqual(['if (!t_relay())', '$var(relay_rc) = $rc;', 'if ($var(relay_rc) > 0)', 'return(1);'])
    // The members woken, and what the replies read of them, before the relay; after it, only the wait (a phony branch).
    expect(ring.indexOf('route(group_wake);')).toBeLessThan(relay)
    expect(ring.indexOf('route(group_wait);')).toBeGreaterThan(relay)
    const wait = code(section('route[group_wait]', 'route[group_wake]'))
    expect(wait.filter(l => l.includes('avp('))).toEqual([])
    expect(wait).toContain('if (!t_wait_for_new_branches())')
    expect(cfg.match(/route\(group_wait\);/g)).toHaveLength(1)
    const wake = section('route[group_wake]', 'route[group_dead]')
    for (const avp of ['g_wake_list', 'g_njoined', 'g_injected', 'g_awaited', 'g_windows']) expect(wake).toContain(`$avp(${avp}) = `)
    expect(wake.match(/raise_event\("E_TWAKEPHONE_WAKE"/g)).toHaveLength(1)
    expect(cfg.match(/raise_event\("E_TWAKEPHONE_WAKE"/g)).toHaveLength(2)
    // None of the windows could be reached: the members with one are woken too (route[group_dead]), not those woken
    // before the relay again; the room left counts the windows placed only.
    expect(wake).toContain('if ($(var(was_woken){s.index,$var(mark)}) == NULL) {')
    const dead = section('route[group_dead]', 'route[group_woken]')
    expect(dead).toContain('if ($avp(g_wake_list) != NULL)\n\t\t$var(placed) = $avp(g_windows) - $avp(g_woken);\n\t$var(room) = 11 - $var(placed);')
    expect(code(section('route[group_hold]', 'route[group_wait]'))).toContain('route(group_wake);')
  })

  it('touches no AVP after a relay that sent, in any request route nor in those that called it, and holds a group without windows with a 180 (review of PR 27, n°3 and n°4)', () => {
    const { cfg } = render()
    // The request routes (route[...] and the main route), as their lines of code; failure, branch, reply and local
    // routes run under the reply lock, or before the transaction's first send.
    const routes = new Map<string, string[]>()
    let current: string[] | undefined
    for (const line of cfg.split('\n')) {
      const start = /^(\w*route)(?:\[(\w+)\])? \{$/.exec(line)
      if (!current && start) {
        current = []
        if (start[1] === 'route') routes.set(start[2] ?? '(main)', current)
        continue
      }
      if (line === '}') current = undefined
      else if (current) {
        const l = line.trim()
        if (l && !l.startsWith('#')) current.push(l)
      }
    }
    expect([...routes.keys()]).toEqual(expect.arrayContaining(['(main)', 'ring', 'ring_loaded', 'ring_now', 'registered_meanwhile', 'relay_call', 'group_ring']))
    const called = (l: string) => [...l.matchAll(/route\((\w+)[,)]/g)].map(m => m[1]!)
    // What runs once the t_relay of line i sent: the forms of the cfg, a new one is to be added here.
    const afterSent = (name: string, lines: string[], i: number): string[] | undefined => {
      const l = lines[i]!
      if (l === 'if (!t_relay()) {') {
        let depth = 1
        let j = i + 1
        for (; depth > 0; j++) depth += (lines[j]!.endsWith('{') ? 1 : 0) - (lines[j]!.startsWith('}') ? 1 : 0)
        return lines.slice(j)
      }
      if (l === 'if (!t_relay())') {
        const rest = lines.slice(i + 2)
        return rest[0] === 'if ($var(relay_rc) > 0)' ? [rest[1]!] : rest
      }
      if (l === 'if (t_relay())') return [lines[i + 1]!]
      // The phony branch (route[past_dead_branches]): to a port nothing listens on, over a transport not served, it
      // sends nothing.
      if (l === 't_relay();' && lines[i - 1] === '$du = "sip:127.0.0.1:9;transport=sctp";') return undefined
      if (l === 't_relay();') return lines.slice(i + 1)
      throw new Error(`route[${name}]: t_relay in a form this test does not know: ${l}`)
    }
    // A route whose lines read or write no AVP, nor those of the routes it calls.
    const avpFree = (name: string, seen = new Set<string>()): boolean => {
      if (seen.has(name)) return true
      seen.add(name)
      const lines = routes.get(name) ?? []
      return lines.every(l => !l.includes('avp(') && called(l).every(c => avpFree(c, seen)))
    }
    // The request routes that may come back to their caller after a relay that sent: what follows the call there
    // runs while the windows' replies are handled.
    const returning = new Set<string>()
    const problems: string[] = []
    for (let changed = true; changed; ) {
      changed = false
      problems.length = 0
      for (const [name, lines] of routes) {
        lines.forEach((l, i) => {
          let tail: string[] | undefined
          if (l.includes('t_relay(')) tail = afterSent(name, lines, i)
          else if (called(l).some(c => returning.has(c))) tail = lines.slice(i + 1)
          if (!tail) return
          const rest = tail.filter(t => t !== '}')
          if (rest[0] === 'exit;') return
          rest.forEach((t, k) => {
            if (t.includes('avp(')) problems.push(`route[${name}], after "${l}": ${t}`)
            for (const c of called(t)) {
              // Only when route[relay_call] sent nothing (3: someone to wake, 4: a group's members to wake).
              if (/^if \(\$var\(relayed\) == [34]\)$/.test(rest[k - 1] ?? '')) continue
              if (!avpFree(c)) problems.push(`route[${name}], after "${l}": route[${c}], which touches AVPs`)
            }
          })
          if (!returning.has(name)) {
            returning.add(name)
            changed = true
          }
        })
      }
    }
    expect(problems).toEqual([])
    // Those that come back: each of their callers stops (exit), or is one of them.
    expect([...returning].sort()).toEqual(['emergency_fallback', 'group_ring', 'registered_meanwhile', 'relay', 'relay_call', 'ring', 'ring_now'])
    // route[relay_call] returns 3 and 4 only once its relay failed: nothing sent.
    const relayCall = routes.get('relay_call')!
    expect(relayCall.indexOf('return(1);')).toBeLessThan(relayCall.indexOf('return(3);'))
    expect(relayCall.indexOf('if ($var(relay_rc) > 0)')).toBe(relayCall.indexOf('return(1);') - 1)
    expect(routes.get('ring_now')).toContain('$var(relayed) = $rc;')
    // The window that registered meanwhile rings: nothing but the end of the wait, and back to route[hold], which exits.
    const meanwhile = routes.get('registered_meanwhile')!
    expect(meanwhile.slice(-2)).toEqual(['t_wait_no_more_branches();', 'return(1);'])
    const hold = routes.get('hold')!
    expect(hold[hold.indexOf('if (route(registered_meanwhile))') + 1]).toBe('exit;')
    // route[ring_loaded], route[group_ring]...: nothing but exit after route(ring) or route(ring_now).
    for (const name of ['ring_loaded', 'names_next', 'names_loaded', 'wake_loaded', 'rules_step', 'group_loaded', 'did_fallback', 'relay_failed']) {
      const lines = routes.get(name)!
      const at = lines.findIndex(l => called(l).some(c => returning.has(c)))
      expect([name, lines[at + 1]]).toEqual([name, 'exit;'])
    }
    // A group none of whose members has a window, held for them (route[group_hold]): it rings, and stops there. Back in
    // route[ring_now] it would wake them again (twice the windows awaited: 480 for 603), then relay to the group's URI.
    const groupHold = routes.get('group_hold')!
    const wake = groupHold.indexOf('route(group_wake);')
    expect(groupHold.slice(wake, wake + 5)).toEqual(['route(group_wake);', 'if ($var(windows) == $avp(g_woken)) {', 't_reply(180, "Ringing");', 'exit;', '}'])
    expect(groupHold.indexOf('route(group_wake);')).toBe(groupHold.lastIndexOf('route(group_wake);'))
    const ringNow = routes.get('ring_now')!
    expect(ringNow.indexOf('route(group_hold);')).toBeLessThan(ringNow.indexOf('route(group_wake);'))
  })

  it('takes the no-answer forward when no window of the callee can be reached, else answers 477, a missed call either way', () => {
    const { cfg } = render()
    const relay = cfg.slice(cfg.indexOf('route[relay_call] {'), cfg.indexOf('#### Voicemail (step 11a'))
    expect(relay).toContain('if (!t_relay())\n\t\t$var(relay_rc) = $rc;')
    const forward = relay.indexOf('if ($var(relay_rc) == -6 && $avp(r_noanswer) != NULL) {')
    expect(forward).toBeGreaterThan(0)
    expect(relay.indexOf('route(rules_local);')).toBeGreaterThan(forward)
    expect(relay).toContain('route(forwarded, $var(relay_from), "477");')
    // Nothing to forward to: the missed call, then the reply (477, or 500 for any other failure).
    const missed = relay.lastIndexOf('route(account_missed);')
    expect(missed).toBeGreaterThan(relay.indexOf('route(rules_local);'))
    // The mailbox of the extension dialled first (step 11a), the same refusal when it does not take the call.
    expect(relay.indexOf('route(voicemail, "unavailable");')).toBeGreaterThan(relay.indexOf('route(rules_local);'))
    expect(relay.indexOf('route(voicemail, "unavailable");')).toBeLessThan(missed)
    expect(relay.indexOf('$avp(vm_code) = 477;\n\t\t$avp(vm_reason) = "Send failed";')).toBeGreaterThan(0)
    expect(relay.indexOf('$avp(vm_code) = 500;\n\t$avp(vm_reason) = "Internal Error";')).toBeGreaterThan(0)
    expect(relay.indexOf('t_reply($avp(vm_code), "$avp(vm_reason)");', missed)).toBeGreaterThan(missed)
    // Every initial INVITE goes through it, in the request route and in failure_route (a direct number's fallback
    // too, step 6b); in-dialog ones keep route[relay].
    expect(cfg.match(/route\(relay_call\);/g)).toHaveLength(4)
    expect(cfg.slice(cfg.indexOf('route[did_fallback] {'), cfg.indexOf('route[did_fallback_undo] {'))).toContain('route(relay_call);')
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
    // The trunk of a call to the public network, the direct number of a call from it: step 6; the caller's rights and
    // caps, a query of its own after the trunk's: step 6b; whether the From of a room's call is one of our accounts:
    // step 8). Three synchronous queries ask the catalog whether the tables
    // of step 4c, that of step 5 or that of step 11a exist, only after a read failed, from the routes that resume a read; three more read
    // the default trunk, the direct numbers and the sites on it every 15 s, in a timer of its own, never in a call (an emergency
    // call's fallback when the trunk of the call cannot be read, with its caller's own number or site). The last two make the
    // direct number's and the trunk's reads again, synchronously, when OpenSIPS dropped them (route[read_again]).
    // One more withdraws what twake_outbound() reserved for a call it refuses after all (review 8b, n°5).
    expect(cfg.match(/sql_query/g)).toHaveLength(19)
    expect(cfg.match(/async\(sql_query/g)).toHaveLength(10)
    const timer = cfg.slice(cfg.indexOf('\ntimer_route[default_trunk, 15] {'), cfg.indexOf('\nroute[emergency_failed] {'))
    expect(timer.match(/sql_query(_one)?\(/g)).toHaveLength(3)
    expect(section('route[tables_4c_missing]', 'route[table_11_missing]').match(/sql_query_one\(/g)).toHaveLength(1)
    expect(section('route[table_11_missing]', 'route[table_5_missing]').match(/sql_query_one\(/g)).toHaveLength(1)
    expect(cfg.match(/route\(table_11_missing\)/g)).toHaveLength(1)
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
    // At most DB_MAX_ASYNC_CONNECTIONS connections of their own per process for these reads (8 by default).
    expect(cfg).toContain('\ndb_max_async_connections=8\n')
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
    // The other headers added to a reply say why a call to the public network was refused (step 6), the only body
    // the operator may be sent (415), and where the operator should take a call that does not go through (step 6b).
    expect(cfg.match(/append_to_reply\((?!"Twake-Call-Refused: |"Accept: application\/sdp\\r\\n"\)|"Contact: <sip:\$var\(trunk_number\)@\$avp\(t_domain\)>\\r\\n"\))/g)).toHaveLength(3)
    expect(reply).toContain('t_reply(480, "Do Not Disturb");')
    expect(reply).toContain('t_reply(480, "Temporarily Unavailable");')
    // Nobody to ring at the end of a forward: the dialled extension's "do not disturb" first.
    const unreachable = section('route[unreachable]', 'route[forward_to]')
    expect(unreachable.indexOf('route(dnd_refuse_dialled);')).toBeGreaterThan(0)
    expect(unreachable.indexOf('route(dnd_refuse_dialled);')).toBeLessThan(unreachable.indexOf('$avp(vm_code) = 404;'))
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
    expect(cfg).toContain('modparam("acc", "extra_fields", "db: caller; callee; dialled; external; via")')
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
    // And a room's call (step 8): "Meet", with the name of whom it calls for when read, never the person's phone.
    expect(cfg.match(/uac_replace_from\(/g)).toHaveLength(4)
    expect(callerName).toContain('$var(caller_name) = "Meet";\n\t\tif ($avp(names_read) == 1 && $avp(n_caller) != NULL && $avp(n_caller) != "")\n\t\t\t$var(caller_name) = "Meet (" + $avp(n_caller) + ")";')
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
    expect(callerName.indexOf('if ($avp(names_read) != 1)\n\t\treturn(-1);')).toBeLessThan(callerName.lastIndexOf('uac_replace_from("$var(caller_name)", "");'))
    const onreply = cfg.slice(cfg.indexOf('onreply_route[rtp] {'), cfg.indexOf('route[event_attrs]'))
    expect(onreply.indexOf('remove_hf("P-Asserted-Identity");')).toBeLessThan(onreply.indexOf('append_hf("P-Asserted-Identity: '))
    expect(onreply).toContain('append_hf("P-Asserted-Identity: \\"$var(pai_name)\\" <sip:$var(pai_ext)@$avp(domain)>\\r\\n");')
    expect(onreply.indexOf('if ($var(pai_ext) =~ "^[A-Za-z0-9._+-]{1,64}$") {')).toBeLessThan(onreply.indexOf('append_hf("P-Asserted-Identity: '))
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
    expect(section('route[group_ring]', 'route[group_place]')).toContain('route(calling);\n\t\troute(did_fallback_request, "nobody of the group", "480");\n\t\tif ($avp(rtp_on) != NULL)\n\t\t\trtpengine_delete();\n\t\troute(account_missed);\n\t\tt_reply(480, "Temporarily Unavailable");')
    expect(section('route[group_ring]', 'route[group_place]').replace(/#.*$/gm, '').trimEnd().endsWith('route(group_order);\n\troute(ring);\n}')).toBe(true)
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
    // A call from the operator: the fallback of its direct number, never after every window declined (review 6b, n°9).
    // Then the mailbox of the number's extension when that fallback was this group (step 11a), then 480.
    expect(group).toContain('route(did_fallback, "the group did not answer", "480");\n\t\t# That fallback was this group')
    expect(group).toContain('\t\t\t$avp(group) = $avp(vm_group);\n\t\t}\n\t\trtpengine_delete();\n\t\troute(group_missed, "480 Temporarily Unavailable");\n\t\tt_reply(480, "Temporarily Unavailable");')
    expect(group.indexOf('route(did_fallback')).toBeGreaterThan(group.indexOf('route(group_missed, $var(group_reply));\n\t\t\texit;'))
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
    expect(failed + probe).not.toMatch(/\$Tsm|q_start|q4c_retry|q_ms|q_sent/)
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
    // A group none of whose windows can be reached: its members are woken (those without a window first, before the
    // relay), not 477.
    const dead = section('route[group_dead]', 'route[group_woken]')
    expect(dead).toContain('$var(room) = 11 - $var(placed);')
    expect(dead.indexOf('route(past_dead_branches);')).toBeLessThan(dead.indexOf('route(group_hold);'))
    expect(section('route[relay_call]', 'route[relay_failed]')).toContain('if ($var(relay_rc) == -6 && $var(relay_request) == 1 && $avp(group) != NULL && ($avp(gd_ext) != NULL || $avp(g_woken) > 0))\n\t\treturn(4);')
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
    // The other one: the fallback of a direct number (step 6b), rung from failure_route.
    expect(cfg.match(/t_on_branch\("tried"\)/g)).toHaveLength(2)
    expect(section('route[did_fallback]', 'route[did_fallback_undo]')).toContain('t_on_branch("tried");')
    // The others: each INVITE to the operator (its first server, the next ones, a challenge answered, the default trunk
    // of an emergency call) through branch_route[trunk_out].
    expect(cfg.match(/t_on_branch\(/g)).toHaveLength(6)
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
    const loaded = section('route[trunk_out_loaded]', 'route[trunk_out_send]')
    const send = section('route[trunk_out_send]', 'route[outbound_count]')
    expect(loaded).toContain('if ($avp(num_class) == "emergency" && route(default_trunk)) {')
    expect(send).toContain('if (!route(default_trunk) || !ds_select_dst($avp(t_setid), 8, "f")) {\n\t\t\troute(emergency_failed, "no server up");')
    // Never cut at TRUNK_MAX_CALL_SEC.
    expect(send).toContain('if ($avp(num_class) == "emergency")\n\t\t$DLG_timeout = 86400;\n\telse if ($avp(o_max_sec) != NULL && $avp(o_max_sec) > 0)\n\t\t$DLG_timeout = $avp(o_max_sec);\n\telse\n\t\t$DLG_timeout = 7200;')
    // Review 6b, n°2: nothing of step 6b is read for it (rights, caps, thresholds): it goes once the trunk is known,
    // told to the Gateway, never refused for it. The others go through the rules (route[outbound_query]) first.
    const emergency = loaded.slice(loaded.lastIndexOf('if ($avp(num_class) != "emergency") {'))
    expect(emergency).toContain('route(outbound_fraud);\n\t\troute(outbound_count);\n\t\troute(outbound_query);\n\t\texit;\n\t}')
    expect(emergency.replace(/#.*$/gm, '').trimEnd().endsWith('route(emergency_event);\n\troute(trunk_out_send);\n}')).toBe(true)
    expect(section('route[trunk_out]', 'route[default_trunk]')).not.toContain('twake_outbound')
    // Every failure of it, the operator's refusal included: "call from another phone".
    expect(section('route[emergency_failed]', 'route[trunk_out_loaded]')).toContain('append_to_reply("Twake-Call-Refused: emergency\\r\\n");\n\tt_reply(503, "Emergency Call Failed");')
    const failed = section('failure_route[trunk_failed]', 'route[trunk_in]')
    expect(failed).toContain('if ($avp(num_class) == "emergency") {\n\t\t$var(failed) = "" + $T_reply_code;\n\t\troute(emergency_failed, $var(failed));\n\t\texit;\n\t}')
    expect(failed.indexOf('route(emergency_failed, $var(failed));')).toBeLessThan(failed.indexOf('if (t_check_status("3[0-9][0-9]")) {'))
  })

  it('keeps the calls in progress across a restart, and rings a direct number\'s fallback inside, never a number outside (review 6b, n°1, n°5, n°9)', () => {
    const { cfg } = render({ TRUNK_MIN_CALL_SEC: '30', OPENSIPS_DB_URL: 'postgres://opensips@db.example.test/opensips' })
    for (const bad of ['0', '601', '1e3', 'x']) expect(render({ TRUNK_MIN_CALL_SEC: bad }).status, bad).toBe(1)
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    // n°5: the dialogs in the database, their values and profiles written as they change (a crash keeps them).
    for (const line of ['modparam("dialog", "db_mode", 2)', 'modparam("dialog", "db_url", "postgres://opensips@db.example.test/opensips")', 'modparam("dialog", "db_update_period", 5)', 'modparam("dialog", "db_flush_vals_profiles", 1)'])
      expect(cfg).toContain(line)
    // The shortest call the minutes left allow, handed to twake_outbound().
    expect(section('route[outbound_query]', 'route[outbound_loaded]')).toContain(", 14400, 30)\";")
    // n°2: rules not read: refused for that reason, never let through, never "no trunk".
    const loaded = section('route[outbound_loaded]', 'route[outbound_rights]')
    expect(loaded).toContain('if ($var(outbound_rc) < 0 || $avp(o_verdict) == NULL) {')
    expect(loaded).toContain('append_to_reply("Twake-Call-Refused: policy-unavailable\\r\\n");\n\t\tt_reply(503, "Call Rules Unavailable");')
    expect(loaded).not.toContain('no-trunk')
    // n°10: the calls in progress counted under one lock, this one in, before the query.
    expect(section('route[outbound_count]', 'route[outbound_query]')).toContain('get_static_lock("outbound_count");\n\tset_dlg_profile("trunk_caller", "$avp(caller)");\n\tset_dlg_profile("trunk_out");\n\tget_profile_size("trunk_caller", "$avp(caller)", $var(u_active));\n\tget_profile_size("trunk_out", , $var(t_active));\n\trelease_static_lock("outbound_count");')
    // n°1: no redirection to the operator anywhere; the fallback is an extension or a group, rung once, never for a
    // number nobody holds, never after a CANCEL.
    expect(cfg).not.toMatch(/t_reply\(30[0-9]|trunk_fallback|fallback_number/)
    const fallback = section('route[did_fallback]', 'route[did_fallback_undo]')
    expect(fallback).toContain('if ($dlg_val(trunk) != "caller" || $avp(fb_used) != NULL || $avp(did_assigned) != 1 || $avp(fb_kind) == NULL || $avp(fb_kind) == "" || t_was_cancelled())\n\t\treturn(-1);')
    expect(fallback).toContain('if (!route(forward_to, $avp(fb_target)))\n\t\treturn(-1);')
    expect(section('route[trunk_in_loaded]', 'route[did_fallback]')).toContain('t_reply(404, "Not Found");')
    // n°9: never after a decline (603, 600), a "do not disturb", nor a group every window of which declined.
    const failed = cfg.slice(cfg.indexOf('failure_route[call_failed]'))
    expect(failed).toContain('if (t_check_status("408|477|480|486|500|503|504") || $var(rang_out) == 1)\n\t\troute(did_fallback, "not answered", $var(code));')
    expect(section('route[dnd_reply]', 'route[dnd_refuse]')).not.toContain('did_fallback')
    // The DID query: the fallback of the number, else its trunk's, its kind (an extension in "do not disturb" is none),
    // the group members not in "do not disturb", and whether the target is anyone's.
    const trunkIn = section('route[trunk_in]', 'route[inbound_number]')
    expect(trunkIn).toContain("coalesce(nullif(d.fallback, ''), t.fallback) AS fb")
    expect(trunkIn).toContain('$avp(did_target);$avp(t_codecs);$avp(fb_target);$avp(fb_kind);$avp(fb_members);$avp(did_assigned)')
  })

  it('never lets a call with the operator or LiveKit SIP be transferred by it, from either side', () => {
    const { cfg } = render()
    const main = cfg.slice(cfg.indexOf('\nroute {'), cfg.indexOf('\nroute[outbound_policy] {'))
    const inDialog = main.slice(main.indexOf('if (has_totag()) {'), main.indexOf('if (is_method("CANCEL")) {'))
    const refer = inDialog.indexOf('if (is_method("REFER") && ($dlg_val(trunk) != NULL || $dlg_val(meet) != NULL)) {')
    expect(refer).toBeGreaterThan(inDialog.indexOf('if (!match_dialog()) {'))
    expect(refer).toBeLessThan(inDialog.indexOf('route(relay);'))
    expect(inDialog.slice(refer)).toMatch(/^[^]*?send_reply\(403, "Transfer Not Allowed"\);\n\t\t\texit;/)
    // Nor completed by an INVITE with Replaces of such a call.
    expect(cfg).toContain('\tif ($dlg_val(trunk) != NULL || $dlg_val(meet) != NULL)\n\t\t$var(replaces_trunk) = 1;\n\tunload_dialog_ctx();')
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
    const replies = inDialog.indexOf('if ($var(from_trunk) == 1) {\n\t\t\t$avp(reply_to_trunk) = 1;\n\t\t\tt_on_reply("rtp");\n\t\t}\n')
    expect(replies).toBeGreaterThan(fromTrunk)
    expect(replies).toBeLessThan(inDialog.indexOf('route(relay);'))
    // Step 8: LiveKit SIP's requests in a call it answered leave from the socket the call came from, not the one their
    // Route names.
    const meetSocket = inDialog.indexOf('if ($var(from_meet) == 1 && $dlg_val(meet) == "callee" && $dlg_val(caller_sock) != NULL)\n\t\t\t$socket_out = $dlg_val(caller_sock);\n\t\troute(relay);')
    expect(meetSocket).toBeGreaterThan(replies)
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
    expect(section('route[trunk_out_loaded]', 'route[trunk_headers]')).toContain('if (has_body_part("application/sdp"))\n\t\troute(rtp_offer);\n\telse\n\t\troute(late_offer);')
    // Whoever sent the INVITE without SDP gets the offer: a phone or browser, the operator, LiveKit SIP (step 8).
    expect(section('route[late_offer]', 'route[rtp_late_offer]')).toContain('$avp(late_offer) = "browser";\n\tif ($var(from_kind) == 1)\n\t\t$avp(late_offer) = "trunk";\n\telse if ($var(from_kind) == 2)\n\t\t$avp(late_offer) = "meet";')
    const reply = section('onreply_route[rtp]', 'route[event_attrs]')
    expect(reply).toContain('if ($avp(late_offer) != NULL) {\n\t\t\tif ($rs >= 200 && $rs < 300)\n\t\t\t\troute(rtp_late_offer);\n\t\t} else {\n\t\t\troute(rtp_answer);')
    expect(section('route[rtp_late_offer]', 'route')).toContain('$dlg_val(late_answer) = "1";')
  })

  it('bounds every call with the operator, and ends it with a BYE to both sides at TRUNK_MAX_CALL_SEC', () => {
    const { cfg } = render({ TRUNK_MAX_CALL_SEC: '7200', MEET_SIP: '192.0.2.20:5080', MEET_SIP_PASSWORD: 'not-a-real-secret-0', MEET_MAX_CALL_SEC: '3600' })
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    // Every INVITE gets its dialog; a call that goes to the operator, its flags once that is known (one of our own
    // direct numbers stays an internal call, route[trunk_out_loaded]).
    expect(cfg.slice(cfg.indexOf('\nroute {'), cfg.indexOf('\nroute[outbound_policy] {'))).toContain('\n\tcreate_dialog();\n')
    const loaded = section('route[trunk_out_loaded]', 'route[trunk_headers]')
    const flags = loaded.indexOf('if ($avp(num_class) == "emergency") {\n\t\tcreate_dialog("B");\n\t\tset_dlg_profile("trunk_emergency");\n\t\t$acc_extra(external) = "emergency";\n\t} else {\n\t\tcreate_dialog("BP");\n\t\t$acc_extra(external) = "out";\n\t}')
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
    // A phone's call to the access number of Meet's rooms (route[meet_call]): B only, LiveKit SIP is not asked either.
    expect(cfg.replace(/#.*$/gm, '').match(/create_dialog\(("[^"]*")?\)/g)).toEqual(['create_dialog()', 'create_dialog("B")', 'create_dialog("B")', 'create_dialog("BP")', 'create_dialog("Bp")'])
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
    const privacy = /\$var\(privacy\) =~ "([^"]+)"\) \{\n(?:\t\t\t.*\n){2}\t\t\t\$var\(from_number\) = "anonymous";/.exec(trunkIn)?.[1]
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
    // The refusal the caller gets, the mailbox of the extension dialled taking the call or not (step 11a).
    const reply = unreachable.indexOf('$avp(vm_code) = 404;')
    expect(unreachable.slice(reply - 3, reply + 3)).toEqual(['$avp(vm_code) = 480;', '$avp(vm_reason) = "Temporarily Unavailable";', 'if ($avp(fwd_hops) == 0 && $avp(dialled_unread) != 1) {', '$avp(vm_code) = 404;', '$avp(vm_reason) = "Not Found";', '}'])
    expect(unreachable).toContain('t_reply($avp(vm_code), "$avp(vm_reason)");')
  })
  it('presents the number of the caller\'s site for an emergency call, in the query it makes already, and from memory when the database is down (step 6c, ADR 0024)', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    const out = section('route[trunk_out]', 'route[default_trunk]')
    // One query: the site is a join of it, for an emergency call only; the others present what they did.
    expect(out.match(/async\(sql_query/g)).toHaveLength(1)
    expect(out).toContain('$var(presented) = "coalesce(d.number, t.default_number)";')
    expect(out).toContain('if ($avp(num_class) == "emergency") {\n\t\t$var(presented) = "coalesce(e.number, d.number, t.default_number)";')
    // The people of a site are joined to the accounts by their holder, as the profiles of step 6b; the caller's user name is checked first.
    expect(out).toContain('JOIN subscriber sb ON sb.holder = eu.user_id WHERE es.trunk_id = t.id AND sb.username = \'" + $var(ext) + "\'')
    expect(out.indexOf('if ($avp(caller) =~ "^[A-Za-z0-9._+-]{1,64}$")')).toBeLessThan(out.indexOf('emergency_sites'))
    // The site's trunk first, for an emergency call only.
    expect(out).toContain('$var(site_order) = "(e.number IS NULL), ";')
    expect(out).toContain('ORDER BY " + $var(site_order) + "(d.number IS NULL), t.position LIMIT 1')
    // Never the query of the rights, never the Gateway.
    expect(out).not.toContain('twake_outbound')
    // From memory (`es:`, with the generation of `dn:`) when the database does not answer, before the direct number.
    const timer = section('timer_route[default_trunk, 15]', 'route[emergency_failed]')
    expect(timer).toContain('cache_store("local", "$var(es_key)", "$var(es_val)", 0);')
    expect(timer).toContain('$var(es_val) = $(avp(es_num)[$var(i)]) + "|" + $var(dn_next);')
    expect(timer.indexOf('$shv(dn_gen) = $var(dn_next);')).toBeGreaterThan(timer.indexOf('cache_store("local", "$var(es_key)"'))
    expect(timer).toContain('es.trunk_id = (SELECT id FROM trunks ORDER BY position LIMIT 1)')
    const fallback = section('route[default_trunk]', 'timer_route[default_trunk, 15]')
    expect(fallback).toContain('$(var(es){s.select,1,|}{s.int}) >= $shv(dn_gen)')
    expect(fallback.indexOf('"es:$avp(caller)"')).toBeGreaterThan(fallback.indexOf('"dn:$avp(caller)"'))
    expect(fallback).toContain('$avp(t_presented) = $(var(es){s.select,0,|});')
  })

  it('keeps what an emergency call presents however long the database is down, bounds the emergency calls a restart restores, and never rings a fallback group where the call has been (second review 6b, n°1, n°4, n°9, n°10)', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`\n${name} {`), cfg.indexOf(`\n${next} {`))
    // n°1: the direct numbers kept with no expiry, of the generation of the last read that succeeded.
    const timer = section('timer_route[default_trunk, 15]', 'route[emergency_failed]')
    expect(timer).toContain('cache_store("local", "$var(dn_key)", "$var(dn_val)", 0);')
    // The number (a string) first: an integer before "+" makes it a sum, which fails (no value stored).
    expect(timer).toContain('$var(dn_val) = $(avp(dn_num)[$var(i)]) + "|" + $var(dn_next);')
    expect(cfg).not.toMatch(/cache_store\("local", "\$var\(dn_key\)"[^)]*, [1-9][0-9]*\);/)
    expect(timer.indexOf('$shv(dn_gen) = $var(dn_next);')).toBeGreaterThan(timer.indexOf('cache_store("local", "$var(dn_key)"'))
    expect(section('route[default_trunk]', 'timer_route[default_trunk, 15]')).toContain('$(var(dn){s.select,1,|}{s.int}) >= $shv(dn_gen)')
    expect(cfg).toContain('modparam("cfgutils", "shvset", "dn_gen=i:0")')
    // n°10: the emergency calls known as such in the database (their profile), a day at most, 2 h once restored.
    expect(cfg).toContain('modparam("dialog", "profiles_no_value", "trunk_out;trunk_emergency;meet_all;vm_all;vm_hidden")')
    const entry = readFileSync(join(dir, 'entrypoint.sh'), 'utf8')
    expect(entry).toContain(`-c "SELECT twake_outbound_restart(${EMERGENCY_RESTORED_SEC})"`)
    // n°4: before OpenSIPS starts, after the tables are there.
    expect(entry.indexOf('twake_outbound_restart')).toBeGreaterThan(entry.indexOf('-f "$TRUNK_SQL"'))
    expect(entry.indexOf('twake_outbound_restart')).toBeLessThan(entry.indexOf('exec "$OPENSIPS_BIN"'))
    // n°9: a member of the fallback group the call rang already (the number's target, a forward) is not rung again.
    const fallback = section('route[did_fallback]', 'route[did_fallback_undo]')
    expect(fallback).toMatch(/\$var\(mark\) = "," \+ \$var\(member\) \+ ",";\n\t+if \(\$\(avp\(fwd_seen\)\{s\.index,\$var\(mark\)\}\) == NULL\) \{\n\t+\$avp\(g_ext\) = \$var\(member\);/)
  })
  it('tells the pilot how long a direct number and its fallback ring, the thresholds of overseas numbers, and that internal calls take media ports too (second review 6b, n°6, n°12, n°13)', () => {
    const tpl = readFileSync(join(dir, 'opensips.cfg.tpl'), 'utf8')
    const pilot = readFileSync(join(dir, '../pilot/README.md'), 'utf8')
    const adr = readFileSync(join(dir, '../../docs/adr/0017-droits-plafonds-fraude-repli.md'), 'utf8')
    const init = readFileSync(join(dir, '../pilot/init.sh'), 'utf8')
    // n°6: the target rings fr_inv_timeout, then the fallback as long; a no-answer forward at the operator only longer.
    const ring = Number(/modparam\("tm", "fr_inv_timeout", ([0-9]+)\)/.exec(tpl)?.[1])
    expect(ring).toBeGreaterThan(0)
    expect(pilot).toContain(`Le numéro sonne ${ring} s, puis le repli ${ring} s : ${2 * ring} s en tout.`)
    expect(pilot).toContain('le renvoi sur indisponibilité seulement')
    expect(pilot).toContain(`à plus de ${2 * ring} s`)
    expect(adr).toContain(`la cible du numéro sonne ${ring} s (\`fr_inv_timeout\`, ou le délai de son renvoi sur non-réponse), puis le repli ${ring} s, soit ${2 * ring} s en tout`)
    expect(pilot).not.toContain('renvoi sur non-réponse et sur indisponibilité de la ligne')
    // n°13: the thresholds of abroad, which overseas numbers have, as FRAUD_DEFAULTS sets them.
    const abroad = FRAUD_DEFAULTS.international
    expect(pilot).toContain(`un avertissement au ${abroad.callsPerMinute?.warning}e appel dans la minute, un refus (\`fraud\`) au ${abroad.callsPerMinute?.critical}e`)
    expect(pilot).toContain(`un avertissement au ${abroad.sequentialCalls?.warning}e appel à la suite vers le même numéro, un refus au ${abroad.sequentialCalls?.critical}e`)
    expect(pilot).toContain(`${abroad.dailyAttempts?.warning} et ${abroad.dailyAttempts?.critical} tentatives par jour`)
    // n°12: the media range counts internal calls, which no cap bounds; init.sh says so and checks ufw.
    expect(pilot).toContain('**appels internes compris**')
    expect(init).toContain('internal ones included')
    expect(init).toContain("! ufw status 2>/dev/null | grep -q '30000:30999/udp'")
  })
})
