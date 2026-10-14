import { describe, expect, it, vi } from 'vitest'
import { decrypt, encrypt, generateSecret, parseKey } from './crypto.js'
import { SipSecrets } from './sip-secrets.js'
import { MemoryStore } from './store/memory.js'

const key = parseKey('00'.repeat(32))

describe('crypto', () => {
  it('round-trips and never leaks the clear text', () => {
    const enc = encrypt('s3cret', key)
    expect(enc).not.toContain('s3cret')
    expect(decrypt(enc, key)).toBe('s3cret')
    expect(() => decrypt(enc, parseKey('11'.repeat(32)))).toThrow()
  })

  it('generates distinct alphanumeric secrets', () => {
    const a = generateSecret(); const b = generateSecret()
    expect(a).toMatch(/^[A-Za-z0-9]{24}$/)
    expect(a).not.toBe(b)
  })
})

describe('SipSecrets', () => {
  it('provisions a random secret on first use, stores it encrypted, and reuses it', async () => {
    const store = new MemoryStore()
    const provisioner = { setSipSecret: vi.fn(async () => {}) }
    const secrets = new SipSecrets({ store, key, provisioner })
    const first = await secrets.getOrCreate('A', 'alice', '101')
    expect(await secrets.getOrCreate('A', 'alice', '101')).toBe(first)
    // Provisioned again with the same secret each time it is handed out: the PBX side may have lost it.
    expect(provisioner.setSipSecret).toHaveBeenCalledTimes(2)
    expect(provisioner.setSipSecret).toHaveBeenNthCalledWith(1, '101', first)
    expect(provisioner.setSipSecret).toHaveBeenNthCalledWith(2, '101', first)
    expect((await store.getSipSecret('A', 'alice'))!.secretEnc).not.toContain(first)
  })

  it('shares one creation between concurrent requests', async () => {
    const provisioner = { setSipSecret: vi.fn(async () => new Promise<void>(r => setTimeout(r, 20))) }
    const secrets = new SipSecrets({ store: new MemoryStore(), key, provisioner })
    const [a, b] = await Promise.all([secrets.getOrCreate('A', 'u', '101'), secrets.getOrCreate('A', 'u', '101')])
    expect(a).toBe(b)
    expect(provisioner.setSipSecret).toHaveBeenCalledTimes(1)
  })

  it('stores nothing when the PBX refuses, so the user is never locked out by a secret the PBX does not know', async () => {
    const store = new MemoryStore()
    const secrets = new SipSecrets({ store, key, provisioner: { setSipSecret: async () => { throw new Error('refused') } } })
    await expect(secrets.getOrCreate('A', 'u', '101')).rejects.toThrow('refused')
    expect(await store.getSipSecret('A', 'u')).toBeNull()
  })

  it('rotates to a new secret', async () => {
    const provisioner = { setSipSecret: vi.fn(async () => {}) }
    const secrets = new SipSecrets({ store: new MemoryStore(), key, provisioner })
    const a = await secrets.getOrCreate('A', 'u', '101')
    const b = await secrets.rotate('A', 'u', '101')
    expect(b).not.toBe(a)
    expect(await secrets.getOrCreate('A', 'u', '101')).toBe(b)
  })

  it('keeps secrets apart per tenant', async () => {
    const secrets = new SipSecrets({ store: new MemoryStore(), key, provisioner: { setSipSecret: async () => {} } })
    expect(await secrets.getOrCreate('A', 'alice', '101')).not.toBe(await secrets.getOrCreate('B', 'alice', '101'))
  })
})
