// Fee rules (USD). The fee is collected by the escrow provider as part of the escrow quote;
// Nexora Hub only calculates and displays the amounts.
export const FEE_PAYERS = ['sender', 'receiver', 'split'];
const cents = (n) => Math.round(n * 100);
const usd = (c) => (c / 100).toFixed(2);

/** Over `threshold` USD: flat `usd`. Over `percentOver` USD: `percent`% of the amount instead. Amounts at or below the threshold are free. */
export function calcFee(amountUsd, { threshold = 50, usd = 2, percentOver = 250, percent = 2 } = {}) {
  const a = Number(amountUsd);
  if (a > percentOver) return cents(a * percent / 100) / 100;
  return a > threshold ? usd : 0;
}
/** Fee settings for a coin: the configured tiers if the coin is in `cfg.feeAssets`, otherwise free. */
/** Deal cap in USD for a coin: free coins (not in `cfg.feeAssets`) have none, fee-paying stablecoins keep `capUsd`. */
export const dealCapFor = (cfg, asset, capUsd) => ((cfg.feeAssets ?? []).includes(String(asset).toUpperCase()) ? capUsd : Infinity);
export const feeCfgFor = (cfg, asset) => ((cfg.feeAssets ?? []).includes(String(asset).toUpperCase()) ? cfg.fee : { ...cfg.fee, usd: 0, percent: 0 });
/** sender sends `send`, receiver gets `receive`, difference is the fee. */
export function calcTotals(amountUsd, feeUsd, payer) {
  const a = cents(amountUsd), f = cents(feeUsd);
  if (f === 0) return { fee: '0.00', send: usd(a), receive: usd(a) };
  if (!FEE_PAYERS.includes(payer)) throw new Error('fee payer required');
  const senderPays = payer === 'sender' ? f : payer === 'split' ? Math.ceil(f / 2) : 0;
  return { fee: usd(f), send: usd(a + senderPays), receive: usd(a - (f - senderPays)) };
}

/** USD worth of `crypto` units of the deal's coin, at the rate quoted when the deal started. Stablecoins count 1:1. */
export function usdWorth(d, crypto) {
  const n = Number(crypto);
  if (!(n >= 0)) return 0;
  return ['USDT', 'USDC'].includes(d.asset) ? n : n * Number(d.rate_usd || 0);
}
