// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { useGateway } from '../gateway.js'
import { I18nProvider } from '../i18n/useT.js'
import { EmergencySiteSettings } from './CallRulesSettings.js'

type Gateway = ReturnType<typeof useGateway>
let gateway: Pick<Gateway, 'client'>
vi.mock('../gateway.js', () => ({ useGateway: () => gateway }))

const flush = () => act(async () => new Promise<void>(resolve => setTimeout(resolve, 0)))

describe('the emergency site in the settings (step 6c)', () => {
  let root: Root
  let host: HTMLDivElement
  const show = async (getEmergencySite: () => Promise<unknown>, lang = 'fr') => {
    localStorage.setItem('twakephone.lang', lang)
    gateway = { client: { getEmergencySite } as unknown as Gateway['client'] }
    // The language is read when the provider starts.
    act(() => root.unmount())
    root = createRoot(host)
    await act(async () =>
      root.render(
        <I18nProvider>
          <EmergencySiteSettings />
        </I18nProvider>
      )
    )
    await flush()
  }
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('tells the person the site their emergency calls leave from, with its address and number, in French and in English', async () => {
    const site = { name: 'Paris', address: '1 rue de Rivoli, 75001 Paris', number: '+33199000350' }
    await show(async () => ({ enabled: true, site }))
    expect(host.querySelector('h2')?.textContent).toBe("Appels d'urgence")
    expect(host.textContent).toContain('partent du site Paris (1 rue de Rivoli, 75001 Paris), avec le numéro +33 1 99 00 03 50')
    await show(async () => ({ enabled: true, site }), 'en')
    expect(host.textContent).toContain('leave from the site Paris (1 rue de Rivoli, 75001 Paris), with the number +33 1 99 00 03 50')
  })

  it('says when no site is attributed, says nothing without trunks, and says when it cannot read', async () => {
    await show(async () => ({ enabled: true }))
    expect(host.textContent).toContain("Aucun site ne vous est attribué : vos appels d'urgence présentent votre numéro direct")
    await show(async () => ({ enabled: false }))
    expect(host.textContent).toBe('')
    await show(async () => Promise.reject(Object.assign(new Error('x'), { status: 404 })))
    expect(host.textContent).toBe('')
    await show(async () => Promise.reject(new Error('down')))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Impossible de lire votre site')
  })
})
