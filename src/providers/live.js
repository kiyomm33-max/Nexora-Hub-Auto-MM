// Real-money provider adapter slot.
// NO adapter is bundled: no provider has been verified for licensing, jurisdiction or API terms.
// To add one, implement createEscrow / cancelEscrow / referDispute against the provider's OFFICIAL API,
// map its signed webhooks to the normalized event shape in docs (README), and register it below.
export const ADAPTERS = {}; // e.g. { 'ProviderName': (cfg) => new ProviderAdapter(cfg) }
