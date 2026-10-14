// Test stub of cozy-interapp, a peer dependency provided by the host Twake Workplace app (vitest.config.ts
// aliases 'cozy-interapp' here). phone-link and phone-widget only need an Intents class with create().start();
// their tests inject their own fake, so this one refuses to run.

class Intents {
  constructor(_options: { client: unknown }) {}
  create(_action: string, _type: string, _data?: object): { start(element: HTMLElement): Promise<unknown> } {
    return { start: async () => { throw new Error('cozy-interapp stub: no intent service in tests') } }
  }
}

export { Intents }
export default Intents
