import { createHash } from 'node:crypto'
import { TRUNK_COUNTRY_EXCLUDED, TRUNK_OUTBOUND_CLASSES, TRUNK_OUTBOUND_DEFAULT, type DidRange, type Trunk } from '@twake/telephony-types'
import { DIALPLAN_SQL } from './numbering.js'
import type { Queryable } from './subscriber.js'

// Everything about the trunks in OpenSIPS's database lives here (step 6, ADR 0016). The Gateway keeps the trunks and
// the direct numbers (its store, the passwords encrypted); this writes their projection: our own `trunks` and `dids`
// (read by opensips.cfg.tpl through sqlops at each external call), and the tables of OpenSIPS's modules,
// `dispatcher` (the operator's servers: OPTIONS every 15 s, failover, the addresses its calls may come from),
// `registrant` (uac_registrant: the registrations to the operator) and `dialplan` (numbering.ts). OpenSIPS loads
// them at its start and on MI ds_reload, reg_reload and dp_reload (the provider asks once a projection changed).

/** Table versions OpenSIPS 3.6 checks in `version` (scripts/postgres/{dispatcher,dialplan,registrant}-create.sql). */
export const DISPATCHER_TABLE_VERSION = 9
export const DIALPLAN_TABLE_VERSION = 5
export const REGISTRANT_TABLE_VERSION = 3

/**
 * OpenSIPS's own tables as its scripts create them, our two, and the numbering plan. `trunks`: one row per trunk,
 * with what the script needs for an outbound call (where, as whom, how numbers are written, which codecs, the number
 * presented by default, the kinds of numbers it may call as `,fixed,mobile,`, the country codes of the international
 * ones as `,32,44,`) and `setid`, its set of `dispatcher` (its servers; the other addresses its calls may come from are
 * in set `setid + SOURCES_SET`, which no call is ever sent to).
 * `dids`: the direct numbers, a range of E.164 numbers
 * of the same length, to an extension or group (`target`) or to the extension that ends with their last
 * `suffix_digits` digits. `tenant_id` is whose they are: OpenSIPS does not read it, and one tenant only may have trunks
 * in a database (TrunkTables refuses a second one).
 * Run as a whole by docker/opensips/entrypoint.sh before OpenSIPS starts (a database created before step 6 has none
 * of these tables, and OpenSIPS would not start without them) and at each start of the Gateway.
 */
export const TRUNK_SCHEMA = `
CREATE TABLE IF NOT EXISTS dispatcher (
    id SERIAL PRIMARY KEY NOT NULL,
    setid INTEGER DEFAULT 0 NOT NULL,
    destination VARCHAR(192) DEFAULT '' NOT NULL,
    socket VARCHAR(128) DEFAULT NULL,
    state INTEGER DEFAULT 0 NOT NULL,
    probe_mode INTEGER DEFAULT 0 NOT NULL,
    weight VARCHAR(64) DEFAULT 1 NOT NULL,
    priority INTEGER DEFAULT 0 NOT NULL,
    attrs VARCHAR(128) DEFAULT NULL,
    description VARCHAR(64) DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS dialplan (
    id SERIAL PRIMARY KEY NOT NULL,
    dpid INTEGER NOT NULL,
    pr INTEGER DEFAULT 0 NOT NULL,
    match_op INTEGER NOT NULL,
    match_exp VARCHAR(64) NOT NULL,
    match_flags INTEGER DEFAULT 0 NOT NULL,
    subst_exp VARCHAR(64) DEFAULT NULL,
    repl_exp VARCHAR(32) DEFAULT NULL,
    timerec VARCHAR(255) DEFAULT NULL,
    disabled INTEGER DEFAULT 0 NOT NULL,
    attrs VARCHAR(255) DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS registrant (
    id SERIAL PRIMARY KEY NOT NULL,
    registrar VARCHAR(255) DEFAULT '' NOT NULL,
    proxy VARCHAR(255) DEFAULT NULL,
    aor VARCHAR(255) DEFAULT '' NOT NULL,
    third_party_registrant VARCHAR(255) DEFAULT NULL,
    username VARCHAR(64) DEFAULT NULL,
    password VARCHAR(64) DEFAULT NULL,
    binding_URI VARCHAR(255) DEFAULT '' NOT NULL,
    binding_params VARCHAR(64) DEFAULT NULL,
    expiry INTEGER DEFAULT NULL,
    forced_socket VARCHAR(64) DEFAULT NULL,
    cluster_shtag VARCHAR(64) DEFAULT NULL,
    state INTEGER DEFAULT 0 NOT NULL,
    CONSTRAINT registrant_registrant_idx UNIQUE (aor, binding_URI, registrar)
);
INSERT INTO version (table_name, table_version) VALUES ('dispatcher', ${DISPATCHER_TABLE_VERSION}), ('dialplan', ${DIALPLAN_TABLE_VERSION}), ('registrant', ${REGISTRANT_TABLE_VERSION})
  ON CONFLICT (table_name) DO NOTHING;
CREATE TABLE IF NOT EXISTS trunks (
    id VARCHAR(32) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    setid INTEGER NOT NULL UNIQUE,
    position INTEGER DEFAULT 0 NOT NULL,
    domain VARCHAR(128) NOT NULL,
    number_format VARCHAR(16) DEFAULT 'e164' NOT NULL,
    assert_identity SMALLINT DEFAULT 0 NOT NULL,
    auth_username VARCHAR(64) DEFAULT '' NOT NULL,
    auth_password VARCHAR(64) DEFAULT '' NOT NULL,
    auth_realm VARCHAR(128) DEFAULT '' NOT NULL,
    codec_flags VARCHAR(255) DEFAULT '' NOT NULL,
    default_number VARCHAR(16) NOT NULL,
    reg_aor VARCHAR(255) DEFAULT '' NOT NULL
);
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS allowed VARCHAR(128) DEFAULT ',${TRUNK_OUTBOUND_DEFAULT.join(',')},' NOT NULL;
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS countries VARCHAR(1024) DEFAULT '' NOT NULL;
CREATE TABLE IF NOT EXISTS dids (
    id VARCHAR(64) PRIMARY KEY NOT NULL,
    tenant_id TEXT DEFAULT '' NOT NULL,
    trunk_id VARCHAR(32) NOT NULL,
    first_number VARCHAR(16) NOT NULL,
    last_number VARCHAR(16) NOT NULL,
    target VARCHAR(64) DEFAULT '' NOT NULL,
    suffix_digits SMALLINT DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS dids_first_number_idx ON dids (first_number);
${DIALPLAN_SQL}`

/**
 * docker/opensips/trunk.sql, which entrypoint.sh runs before each start of OpenSIPS (psql): the tables its modules
 * need for the trunks, and the numbering plan, on a database created before step 6 too (the `version` table first,
 * on an empty one).
 */
export const TRUNK_SQL = `-- Generated from packages/provider-opensips/src/trunks.ts (TRUNK_SQL): do not edit, a unit test compares them.
CREATE TABLE IF NOT EXISTS version (
    table_name VARCHAR(32) NOT NULL,
    table_version INTEGER DEFAULT 0 NOT NULL,
    CONSTRAINT version_t_name_idx UNIQUE (table_name)
);
${TRUNK_SCHEMA.trim()}
`

/**
 * The set of `dispatcher` that holds the other addresses a trunk's calls may come from (`sources`): its own set plus
 * this. ds_is_in_list() (the trunk socket's check) reads every set; ds_select_dst() is only ever asked for a trunk's own
 * set: no call goes to a source, whatever state the dispatcher gives it.
 */
export const SOURCES_SET = 1000

/** The UDP socket of OpenSIPS for the trunks (`udp:IP:PORT`): where it registers and sends from, never 5060 by default. */
export const DEFAULT_TRUNK_SOCKET = 'udp:127.0.0.1:5070'

// IPv4 only, as entrypoint.sh's TRUNK_LISTEN_IP: an operator's address in IPv6 could never reach an IPv4 socket.
const SOCKET = /^udp:([0-9]{1,3}(?:\.[0-9]{1,3}){3}):(\d{1,5})$/
const HOST_PORT = /^([A-Za-z0-9.-]+)(:\d{1,5})?$/
const IP = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/
const E164 = /^\+[1-9][0-9]{6,14}$/
const COUNTRY = /^[1-9][0-9]{0,2}$/
/** What may go into a SIP URI's user part or a quoted SQL literal here, and nothing else. */
const SIP_USER = /^[A-Za-z0-9._+-]{1,64}$/

/**
 * The flags of rtpengine for the trunk's side: plain RTP (RTP/AVP, no ICE, no DTLS nor SDES, RTCP on its own port),
 * only the trunk's codecs, and DTMF as RFC 4733 events.
 */
export const codecFlags = (codecs: readonly string[]) => ['codec-strip-all', ...codecs.map(c => `codec-except-${c}`), 'codec-except-telephone-event'].join(' ')

/**
 * The password as OpenSIPS keeps it for this trunk: the digest HA1 (MD5 of user:realm:password, "0x" and 32 hex
 * digits, which uac_auth recognises) when the realm is known, so that a dump of its database gives the password away
 * for that realm only; the password itself otherwise (OpenSIPS needs it to answer the operator's challenges).
 */
export const trunkSecret = (username: string, realm: string | undefined, password: string) => (realm ? `0x${createHash('md5').update(`${username}:${realm}:${password}`).digest('hex')}` : password)

interface Projection {
  trunks: unknown[][]
  dids: unknown[][]
  dispatcher: unknown[][]
  registrant: unknown[][]
}

const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 })

/**
 * Rows of the four tables for these trunks and numbers, the first trunk the one of those without a direct number;
 * throws on anything that could not go into them. `advertise` (`host[:port]`, TRUNK_ADVERTISE of entrypoint.sh): the
 * address OpenSIPS announces on the trunk socket, which the registrations bind to.
 */
export const projectTrunks = (trunks: (Trunk & { password?: string })[], dids: DidRange[], socket: string, advertise?: string): Projection => {
  const s = SOCKET.exec(socket)
  if (!s) throw new Error(`Trunk socket ${socket} is not udp:IPv4:PORT`)
  if (advertise !== undefined && !HOST_PORT.test(advertise)) throw new Error(`Trunk advertised address ${advertise} is not host[:port]`)
  const bindingHost = advertise ? (advertise.includes(':') ? advertise : `${advertise}:${s[2]}`) : `${s[1]}:${s[2]}`
  const out: Projection = { trunks: [], dids: [], dispatcher: [], registrant: [] }
  // A trunk's set never reaches the sets of the sources.
  if (trunks.length >= SOURCES_SET) throw invalid(`At most ${SOURCES_SET - 1} trunks`)
  trunks.forEach((t, position) => {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(t.id)) throw invalid(`Trunk id ${t.id} is not valid`)
    if (!HOST_PORT.test(t.domain) || t.domain.includes(':')) throw invalid(`Trunk ${t.id}: domain is not a host name`)
    if (!E164.test(t.defaultNumber)) throw invalid(`Trunk ${t.id}: the default number is not E.164`)
    const username = t.username ?? ''
    if (username && !SIP_USER.test(username)) throw invalid(`Trunk ${t.id}: user name is not a SIP user`)
    const secret = t.password ? trunkSecret(username, t.realm, t.password) : ''
    if (secret.length > 64) throw invalid(`Trunk ${t.id}: password longer than 64 characters`)
    const setid = position + 1
    const servers = t.proxies?.length ? t.proxies : [t.domain]
    for (const p of servers) if (!HOST_PORT.test(p)) throw invalid(`Trunk ${t.id}: server ${p} is not host[:port]`)
    for (const ip of t.sources ?? []) if (!IP.test(ip)) throw invalid(`Trunk ${t.id}: source ${ip} is not an IP address`)
    const register = t.auth === 'register'
    if (register && !(username && t.password)) throw invalid(`Trunk ${t.id}: registering needs a user name and a password`)
    const aor = register ? `sip:${username}@${t.domain}` : ''
    const allowed = t.allowed ?? TRUNK_OUTBOUND_DEFAULT
    if (!allowed.every(c => (TRUNK_OUTBOUND_CLASSES as readonly string[]).includes(c))) throw invalid(`Trunk ${t.id}: allowed is some of ${TRUNK_OUTBOUND_CLASSES.join(', ')}`)
    const countries = t.countries ?? []
    if (!countries.every(c => COUNTRY.test(c) && !TRUNK_COUNTRY_EXCLUDED.test(c))) throw invalid(`Trunk ${t.id}: countries are country codes of one to three digits, neither France nor its overseas ones, nor a code of no country`)
    if (allowed.includes('international') !== countries.length > 0) throw invalid(`Trunk ${t.id}: international numbers are called to the countries listed only (countries), and countries go with international`)
    out.trunks.push([t.id, setid, position, t.domain, t.numberFormat, t.assertIdentity ? 1 : 0, username, secret, t.realm ?? '', codecFlags(t.codecs), t.defaultNumber, aor, `,${allowed.join(',')},`, countries.length ? `,${countries.join(',')},` : ''])
    // The operator's servers, in order, each probed with OPTIONS (probe_mode 1): it keeps the NAT open towards each
    // (ARCHITECTURE §13). The dispatcher tries the highest priority first (algorithm 8): the first server has the
    // highest. Its other addresses: in a set of their own that no call is sent to (SOURCES_SET), never probed, only
    // recognised by the trunk socket.
    servers.forEach((p, i) => out.dispatcher.push([setid, `sip:${p}`, socket, 0, 1, '1', servers.length - i, '', t.id]))
    for (const ip of t.sources ?? []) out.dispatcher.push([setid + SOURCES_SET, `sip:${ip}`, socket, 0, 0, '1', 0, '', t.id])
    if (register) {
      const registrar = `sip:${t.registrar ?? t.domain}`
      const proxy = t.proxies?.length ? `sip:${t.proxies[0]}` : null
      out.registrant.push([registrar, proxy, aor, username, secret, `sip:${username}@${bindingHost}`, t.registerExpires ?? 600, socket])
    }
  })
  for (const d of dids) {
    if (!trunks.some(t => t.id === d.trunkId)) throw invalid(`Direct number ${d.first}: no trunk ${d.trunkId}`)
    if (!E164.test(d.first) || !E164.test(d.last) || d.first.length !== d.last.length || d.first > d.last) throw invalid(`Direct numbers ${d.first} to ${d.last} are no range of E.164 numbers`)
    const target = d.target ?? ''
    const suffix = d.suffixDigits ?? 0
    if (suffix ? target || suffix < 2 || suffix > 6 : !SIP_USER.test(target)) throw invalid(`Direct number ${d.first}: a target or a number of digits`)
    out.dids.push([d.id.slice(0, 64), d.trunkId, d.first, d.last, target, suffix])
  }
  return out
}

export interface TrunkTablesOptions {
  pool: Queryable
  /** Awaited before each query: the schema check of the provider. */
  ready?: () => Promise<void>
  tenantId?: string
  /** OpenSIPS's trunk socket (TRUNK_LISTEN_IP and TRUNK_PORT of entrypoint.sh): DEFAULT_TRUNK_SOCKET by default. */
  socket?: string
  /** The address OpenSIPS announces on it (TRUNK_ADVERTISE), `host[:port]`: the registrations bind to it. */
  advertise?: string
}

/** The rows of `dispatcher` of the tenant's trunks: their servers and their sources. */
const OF_TENANT = `setid IN (SELECT setid FROM trunks WHERE tenant_id = $1 UNION ALL SELECT setid + ${SOURCES_SET} FROM trunks WHERE tenant_id = $1)`

const sameRows = (a: unknown[][], b: unknown[][]) => JSON.stringify(a) === JSON.stringify(b)

/** Writes the tenant's projection; says which of OpenSIPS's tables changed (the provider reloads only those). */
export class TrunkTables {
  private readonly tenantId: string
  readonly socket: string
  readonly advertise: string | undefined

  constructor(private readonly opts: TrunkTablesOptions) {
    this.tenantId = opts.tenantId ?? 'default'
    this.socket = opts.socket ?? DEFAULT_TRUNK_SOCKET
    this.advertise = opts.advertise || undefined
    if (!SOCKET.test(this.socket)) throw new Error(`Trunk socket ${this.socket} is not udp:IPv4:PORT`)
    if (this.advertise !== undefined && !HOST_PORT.test(this.advertise)) throw new Error(`Trunk advertised address ${this.advertise} is not host[:port]`)
  }

  /** What the database holds for the tenant now, in the order of projectTrunks. */
  private async current(q: Queryable): Promise<Projection> {
    const rows = async (text: string) => (((await q.query(text, [this.tenantId])) as { rows?: Record<string, unknown>[] } | undefined)?.rows ?? []).map(r => Object.values(r))
    return {
      trunks: await rows('SELECT id, setid, position, domain, number_format, assert_identity, auth_username, auth_password, auth_realm, codec_flags, default_number, reg_aor, allowed, countries FROM trunks WHERE tenant_id = $1 ORDER BY position'),
      dids: await rows('SELECT id, trunk_id, first_number, last_number, target, suffix_digits FROM dids WHERE tenant_id = $1 ORDER BY first_number, id'),
      dispatcher: await rows(`SELECT setid, destination, socket, state, probe_mode, weight, priority, attrs, description FROM dispatcher WHERE ${OF_TENANT} ORDER BY setid, priority DESC, id`),
      registrant: await rows("SELECT registrar, proxy, aor, username, password, binding_uri, expiry, forced_socket FROM registrant WHERE aor IN (SELECT reg_aor FROM trunks WHERE tenant_id = $1 AND reg_aor <> '') ORDER BY id")
    }
  }

  /**
   * Exactly these trunks and direct numbers for the tenant, in one transaction. Nothing is written when the database
   * holds them already: OpenSIPS is asked to reload nothing (a registration is not sent again for nothing). Refused
   * (409) when another tenant has trunks in this database: OpenSIPS's script reads one tenant's trunks only.
   */
  async set(trunks: (Trunk & { password?: string })[], dids: DidRange[]): Promise<{ dispatcher: boolean; registrant: boolean }> {
    const wanted = projectTrunks(trunks, dids, this.socket, this.advertise)
    wanted.dids.sort((a, b) => String(a[2]).localeCompare(String(b[2])) || String(a[0]).localeCompare(String(b[0])))
    // As current() reads them: by set (the servers of each trunk, then the sources), the highest priority first.
    wanted.dispatcher.sort((a, b) => Number(a[0]) - Number(b[0]) || Number(b[6]) - Number(a[6]))
    await this.opts.ready?.()
    const client = this.opts.pool.connect ? await this.opts.pool.connect() : undefined
    const q = client ?? this.opts.pool
    try {
      await q.query('BEGIN')
      // Whose trunks the database holds is read under a lock that two writers cannot hold at once (each taking it
      // waits for the other to commit): two tenants writing their first trunks at the same time never both pass.
      await q.query('LOCK TABLE trunks IN SHARE ROW EXCLUSIVE MODE')
      if (wanted.trunks.length) {
        const other = (await q.query('SELECT tenant_id FROM trunks WHERE tenant_id <> $1 LIMIT 1', [this.tenantId])) as { rows?: unknown[] } | undefined
        if (other?.rows?.length)
          throw Object.assign(new Error("OpenSIPS's database holds the trunks of another tenant: trunks for one tenant per database"), { statusCode: 409, code: 'TRUNK_OTHER_TENANT' })
      }
      const now = await this.current(q)
      const changed = {
        dispatcher: !sameRows(now.dispatcher, wanted.dispatcher),
        registrant: !sameRows(now.registrant, wanted.registrant)
      }
      if (!changed.dispatcher && !changed.registrant && sameRows(now.trunks, wanted.trunks) && sameRows(now.dids, wanted.dids)) {
        await q.query('COMMIT')
        return changed
      }
      await q.query("DELETE FROM registrant WHERE aor IN (SELECT reg_aor FROM trunks WHERE tenant_id = $1 AND reg_aor <> '')", [this.tenantId])
      await q.query(`DELETE FROM dispatcher WHERE ${OF_TENANT}`, [this.tenantId])
      await q.query('DELETE FROM dids WHERE tenant_id = $1', [this.tenantId])
      await q.query('DELETE FROM trunks WHERE tenant_id = $1', [this.tenantId])
      for (const r of wanted.trunks)
        await q.query(
          'INSERT INTO trunks (tenant_id, id, setid, position, domain, number_format, assert_identity, auth_username, auth_password, auth_realm, codec_flags, default_number, reg_aor, allowed, countries) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)',
          [this.tenantId, ...r]
        )
      for (const r of wanted.dids) await q.query('INSERT INTO dids (tenant_id, id, trunk_id, first_number, last_number, target, suffix_digits) VALUES ($1, $2, $3, $4, $5, $6, $7)', [this.tenantId, ...r])
      for (const r of wanted.dispatcher) await q.query('INSERT INTO dispatcher (setid, destination, socket, state, probe_mode, weight, priority, attrs, description) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', r)
      for (const r of wanted.registrant) await q.query('INSERT INTO registrant (registrar, proxy, aor, username, password, binding_URI, expiry, forced_socket) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', r)
      await q.query('COMMIT')
      return changed
    } catch (err) {
      await q.query('ROLLBACK').catch(() => undefined)
      throw err
    } finally {
      client?.release()
    }
  }
}
