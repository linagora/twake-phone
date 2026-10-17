export { OVH_ENDPOINTS, OVH_TIMEOUT_MS, OvhClient, ovhSignature, type OvhClientOptions, type OvhCredentials } from './client.js'
export { fromOvhNumber, toOvhNumber } from './numbers.js'
export { OvhOperator, type OvhOperatorOptions } from './operator.js'
import { OvhOperator } from './operator.js'

/**
 * OVHcloud from the environment (the pilot kit): OVH_APPLICATION_KEY, OVH_APPLICATION_SECRET, OVH_CONSUMER_KEY and
 * OVH_BILLING_ACCOUNT, all four or none (undefined: no operator); OVH_ENDPOINT, `ovh-eu` by default. The keys are
 * read here only, never written anywhere. Throws, naming the variable, on anything missing or invalid.
 */
export const ovhOperatorFromEnv = (env: NodeJS.ProcessEnv): OvhOperator | undefined => {
  const names = ['OVH_APPLICATION_KEY', 'OVH_APPLICATION_SECRET', 'OVH_CONSUMER_KEY', 'OVH_BILLING_ACCOUNT'] as const
  const given = names.filter(n => env[n])
  if (!given.length) return undefined
  const missing = names.filter(n => !env[n])
  if (missing.length) throw new Error(`${missing.join(', ')}: required with ${given.join(', ')} (OVHcloud, step 10b)`)
  return new OvhOperator({
    applicationKey: env.OVH_APPLICATION_KEY!,
    applicationSecret: env.OVH_APPLICATION_SECRET!,
    consumerKey: env.OVH_CONSUMER_KEY!,
    billingAccount: env.OVH_BILLING_ACCOUNT!,
    ...(env.OVH_ENDPOINT ? { endpoint: env.OVH_ENDPOINT } : {})
  })
}
