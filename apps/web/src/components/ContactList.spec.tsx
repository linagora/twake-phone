// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { Contact } from '@twake/telephony-client'
import { ContactList } from './ContactList.js'

vi.mock('../i18n/useT.js', () => ({ useT: () => ({ lang: 'fr', t: (key: string) => key }) }))
vi.mock('../presence.js', () => ({ PresenceBadge: () => null }))

describe('ContactList', () => {
  it('shows the directory photo as a decorative image, and the initials without one', () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const photo = 'data:image/png;base64,iVBORw0KGgo='
    const contacts: Contact[] = [
      { id: 'jd', displayName: 'Jean Dupont', numbers: [], photo },
      { id: 'am', displayName: 'Alice Martin', numbers: [] }
    ]
    const div = document.createElement('div')
    const root = createRoot(div)
    act(() => root.render(<MemoryRouter><ContactList contacts={contacts} /></MemoryRouter>))
    const imgs = div.querySelectorAll('img')
    expect(imgs).toHaveLength(1)
    expect(imgs[0]?.getAttribute('src')).toBe(photo)
    expect(imgs[0]?.getAttribute('alt')).toBe('')
    expect(div.textContent).toContain('AM')
    act(() => root.unmount())
  })
})
