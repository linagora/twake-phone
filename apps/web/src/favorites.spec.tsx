// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Contact } from '@twake/telephony-client'
import { useGateway, type Me } from './gateway.js'
import { FavoritesProvider, useFavorites, type Favorites } from './favorites.js'

type Gateway = ReturnType<typeof useGateway>
// What useGateway() hands the provider, changed by each test between renders.
let gateway: Pick<Gateway, 'client' | 'me'>
vi.mock('./gateway.js', () => ({ useGateway: () => gateway }))

const contact = (id: string): Contact => ({ id, displayName: id, numbers: [] })
const me = (directory: boolean): Me => ({ features: { directory } }) as unknown as Me
/** A client whose favourites answer when the test says so. */
const deferredClient = () => {
  const answers: ((items: Contact[]) => void)[] = []
  const getFavorites = vi.fn(() => new Promise<{ items: Contact[] }>(resolve => answers.push(items => resolve({ items }))))
  return { client: { getFavorites } as unknown as Gateway['client'], getFavorites, answer: (i: number, items: Contact[]) => answers[i]!(items) }
}

describe('FavoritesProvider', () => {
  let root: Root
  let seen: Favorites | undefined
  const Probe = () => {
    seen = useFavorites()
    return null
  }
  const render = () => act(() => root.render(<FavoritesProvider><Probe /></FavoritesProvider>))

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    root = createRoot(document.createElement('div'))
  })
  afterEach(() => act(() => root.unmount()))

  it('asks nothing before the Gateway says who the user is, and nothing on a platform without a directory', () => {
    const a = deferredClient()
    gateway = { client: a.client, me: null }
    render()
    expect(a.getFavorites).not.toHaveBeenCalled()
    expect(seen?.items).toBeNull()
    gateway = { client: a.client, me: me(false) }
    render()
    expect(a.getFavorites).not.toHaveBeenCalled()
    expect(seen?.items).toEqual([])
    expect(seen?.error).toBe(false)
  })

  it('keeps the answer to the latest load, not one that arrives after it', async () => {
    const a = deferredClient()
    const b = deferredClient()
    gateway = { client: a.client, me: me(true) }
    render()
    expect(a.getFavorites).toHaveBeenCalledTimes(1)
    // A new client (a new token): its load starts while the first one is still on its way.
    gateway = { client: b.client, me: gateway.me }
    render()
    await act(async () => b.answer(0, [contact('new')]))
    expect(seen?.items?.map(c => c.id)).toEqual(['new'])
    await act(async () => a.answer(0, [contact('old')]))
    expect(seen?.items?.map(c => c.id)).toEqual(['new'])
  })
})
