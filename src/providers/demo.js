import crypto from 'node:crypto';
// DEMO / testnet provider. Nothing here touches real money; every address and reference is clearly fake.
// Fixed, obviously-not-live rates used only for demo quotes.
const DEMO_RATES = { BTC: 65000, ETH: 3000, LTC: 41.23, SOL: 150, USDT: 1, USDC: 1 };
export class DemoProvider {
  name = 'Demo Escrow (simulated)';
  live = false;
  async createEscrow(deal) {
    const tag = crypto.randomBytes(6).toString('hex').toUpperCase();
    const rate = DEMO_RATES[deal.asset] ?? 1;
    return { reference: `DEMO-${tag}`, address: `DEMO-NOT-A-REAL-ADDRESS-${tag}`, payAmount: (Number(deal.send_usd) / rate).toFixed(8), rateUsd: rate.toFixed(2), instructions: 'DEMO MODE' };
  }
  async usdRate(d) { return DEMO_RATES[d.asset] ?? 1; }
  async cancelEscrow() { return { ok: true }; }
  async referDispute() { return { ok: true, note: 'Demo: dispute recorded (no real provider contacted).' }; }
  /** The sender approved release. A real provider would now wait for the receiver's payout address. */
  async requestRelease() { return { accepted: true }; }
  /** Ask the provider to pay out to the receiver's address. In demo the provider "completes" immediately. */
  async requestPayout() { return { accepted: true, simulateEvent: 'escrow.completed' }; }
}
