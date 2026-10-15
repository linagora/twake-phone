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
    const main = cfg.slice(cfg.indexOf('\nroute {'), cfg.indexOf('\nroute[relay]'))
    const lines = main.split('\n').map(l => l.trim())
    const at = (line: string, from = 0) => lines.indexOf(line, from)
    // The lookup is route[reach]'s (with the no-answer forward of an extension nobody registered).
    const reach = at('if (!route(reach)) {')
    const offer = at('route(rtp_offer);', reach)
    const calling = at('route(calling);', offer)
    expect([reach, offer, calling].every(i => i > 0)).toBe(true)
    expect(lines[calling + 1]).toBe('route(relay);')
    expect(cfg.slice(cfg.indexOf('route[reach] {'), cfg.indexOf('route[forward_to] {'))).toContain('while (!lookup("location")) {')
    // The 404 of an extension nobody registered goes through a transaction (acc sees it): announced just before.
    expect(lines.slice(reach, reach + 5)).toEqual(['if (!route(reach)) {', expect.stringMatching(/^#/), 'route(account_missed);', 'route(calling);', 't_reply(404, "Not Found");'])
    expect(cfg.match(/raise_event\("E_TWAKEPHONE_CALLING"/g)).toHaveLength(1)
    // No transaction before t_relay: tm then answers 477 itself to a contact it cannot send to (e2e "dead connection").
    expect(cfg.slice(cfg.indexOf('route[calling]'), cfg.indexOf('route[relay]'))).not.toContain('t_newtran')
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
    expect(cfg).toContain('modparam("sqlops", "db_url", "postgres://opensips@db.example.test/opensips")')
    const load = cfg.slice(cfg.indexOf('route[load_rules] {'), cfg.indexOf('route[rules_before] {'))
    const check = load.indexOf('if (!($rU =~ "^[A-Za-z0-9._+-]{1,64}$"))')
    expect(check).toBeGreaterThan(0)
    expect(load.indexOf('sql_query_one(')).toBeGreaterThan(check)
    expect(load).toContain("FROM call_rules WHERE extension = '$rU'")
    expect(load).toContain('dnd_until > now()')
    // One query, one place: every rule comes from route[load_rules].
    expect(cfg.match(/sql_query/g)).toHaveLength(1)
  })

  it('caps the forwards of a call, and spares the INVITE of an attended transfer the rules of its callee', () => {
    const { cfg } = render()
    const section = (name: string, next: string) => cfg.slice(cfg.indexOf(`${name} {`), cfg.indexOf(`${next} {`))
    const fwd = section('route[forward_to]', 'route[arm_failure]')
    expect(fwd).toContain('if ($avp(fwd_hops) >= 3) {')
    expect(fwd).toContain('if ($param(1) == $avp(caller) || $(avp(fwd_seen){s.index,$var(seen)}) != NULL) {')
    expect(cfg).toContain('if (!is_present_hf("Replaces"))\n\t\troute(rules_before);')
    const refuse = section('route[dnd_refuse]', 'route[forwarded]')
    expect(refuse).toContain('t_reply(480, "Do Not Disturb");')
    expect(refuse).toContain('append_to_reply("Twake-Dnd-Message: $avp(r_message)\\r\\n");')
    // A failure forwards on the statuses the ADR names, and only then.
    expect(cfg).toContain('t_check_status("486|600|603") && $avp(r_busy) != NULL')
    expect(cfg).toContain('t_check_status("408|477|480|503") && $avp(r_noanswer) != NULL')
  })
})
