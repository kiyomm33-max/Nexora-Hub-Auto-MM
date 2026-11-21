import { LtcWallet } from './ltc.js';
import { EvmWallet } from './evm.js';
import { SolWallet } from './sol.js';

/** Routes each deal to the wallet that handles its coin and network. All wallets share one recovery phrase. */
export class MultiProvider {
  name = 'Nexora Wallet';
  live = true;
  constructor(cfg, db, { ltc, evm, sol } = {}) {
    this.cfg = cfg; this.db = db;
    this.ltc = ltc ?? new LtcWallet(cfg, db);
    const m = { mnemonic: this.ltc.mnemonic, source: this.ltc.source };
    this.evm = evm ?? new EvmWallet(cfg, db, { mnemonic: m });
    this.sol = sol ?? new SolWallet(cfg, db, { mnemonic: m });
    this.mnemonic = this.ltc.mnemonic; this.source = this.ltc.source; this.treasury = this.ltc.treasury;
  }
  #for(d) {
    if (!d) return this.ltc;
    if (d.asset === 'LTC') return this.ltc;
    if (this.evm.supports(d.asset, d.network)) return this.evm;
    if (this.sol.supports(d.asset, d.network)) return this.sol;
    throw new Error(`${d.asset} on ${d.network} is not supported by the wallet.`);
  }
  #byId(id) { return this.#for(this.db.prepare('SELECT asset, network FROM deals WHERE id=?').get(id)); }
  supports(asset, network) { return asset === 'LTC' || this.evm.supports(asset, network) || this.sol.supports(asset, network); }
  validateAddress(addr, deal) { return this.#for(deal).validateAddress(addr); }
  createEscrow(deal) { return this.#for(deal).createEscrow(deal); }
  cancelEscrow(deal) { return this.#for(deal).cancelEscrow(deal); }
  referDispute(deal, reason) { return this.#for(deal).referDispute(deal, reason); }
  requestRelease(deal) { return this.#for(deal).requestRelease(deal); }
  requestPayout(deal) { return this.#for(deal).requestPayout(deal); }
  payoutInfo(id) { return this.#byId(id).payoutInfo(id); }
  acceptShort(id) { return this.#byId(id).acceptShort(id); }
  sweep(id, to) { return this.#byId(id).sweep(id, to); }
  explorerTx(txid, deal) { return this.#for(deal).explorerTx(txid, deal); }
  async scan(emit) { for (const w of [this.ltc, this.evm, this.sol]) await w.scan(emit); }
  start(emit) { this.ltc.start(emit); this.evm.start(emit); this.sol.start(emit); }
  /** Addresses the owner needs to know about (shown by /staff wallet). */
  describe() {
    return [
      { label: 'LTC fee address', value: this.ltc.treasury },
      { label: 'ETH / BNB / token fee address', value: this.evm.treasury },
      { label: 'Gas wallet (fund with a little ETH and BNB so USDT/USDC payouts can pay network fees)', value: this.evm.gasAddress },
      { label: 'SOL fee address', value: this.sol.treasury },
    ];
  }
}
