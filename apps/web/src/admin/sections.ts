import type { Key } from '../i18n/index.js'

/** The parts of the administration (step 7), in the order of its navigation: the path under /admin, and its name. */
export const ADMIN_SECTIONS: readonly (readonly [string, Key])[] = [
  ['', 'admin.nav.accounts'],
  ['trunks', 'admin.nav.trunks'],
  ['numbers', 'admin.nav.numbers'],
  ['groups', 'admin.nav.groups'],
  ['rights', 'admin.nav.rights'],
  ['limits', 'admin.nav.limits'],
  ['alerts', 'admin.nav.alerts']
]

/** The name of the part of the administration at `pathname`, when it is one under /admin (not /admin itself). */
export const adminSectionOf = (pathname: string): Key | undefined => {
  const m = /^\/admin\/([^/]+)\/?$/.exec(pathname)
  return m ? ADMIN_SECTIONS.find(([path]) => path === m[1])?.[1] : undefined
}
