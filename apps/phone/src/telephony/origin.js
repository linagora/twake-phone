/**
 * Whether a page origin belongs to the same Twake instance as this page. Used to decide who may ask the widget
 * to place a call: the app that embeds it, never an arbitrary site.
 *
 * Instances name their apps either `<instance>-<slug>.<base>` (flat) or `<slug>.<instance>.<base>` (nested);
 * `instanceDomain` is the instance itself, e.g. "user1.twake.local".
 */
export const isSameInstanceOrigin = (origin, instanceDomain) => {
  let host
  try {
    host = new URL(origin).hostname
  } catch {
    return false
  }
  const instance = instanceDomain.split(':')[0]
  if (host === instance) return true
  if (host.endsWith(`.${instance}`)) return true // nested: drive.user1.twake.local
  const [label, ...rest] = instance.split('.')
  const base = rest.join('.')
  return (
    Boolean(base) &&
    new RegExp(
      `^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[a-z0-9]+\\.${base.replace(/\./g, '\\.')}$`
    ).test(host)
  )
}
