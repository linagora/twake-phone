// Test stub of cozy-client, a peer dependency provided by the host Twake Workplace app (vitest.config.ts
// aliases 'cozy-client' here). Only what packages/phone-link/src/index.tsx imports; tests pass their own client.

/** A link to the app `slug` on the stack, with the same pathname and hash as cozy-client's generateWebLink. */
export const generateWebLink = ({ cozyUrl, slug, pathname = '/', hash = '' }: { cozyUrl: string; slug: string; subDomainType?: string; pathname?: string; hash?: string }): string =>
  `${cozyUrl.replace(/\/$/, '')}/${slug}${pathname}#${hash.replace(/^#/, '')}`

/** The host app's CozyClient; there is none in the tests. */
export const useClient = (): unknown => undefined
