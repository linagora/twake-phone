declare module 'cozy-interapp' {
  const Intents: new (options: { client: unknown }) => unknown
  export default Intents
}
declare module 'cozy-client' {
  export const useClient: () => unknown
  export const generateWebLink: (options: Record<string, unknown>) => string
}
