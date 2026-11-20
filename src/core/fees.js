// Fee rules (USD). The fee is collected by the escrow provider as part of the escrow quote;
// Nexora Hub only calculates and displays the amounts.
export const FEE_PAYERS = ['sender', 'receiver', 'split'];
const cents = (n) => Math.round(n * 100);
const usd = (c) => (c / 100).toFixed(2);

export function calcFee(amountUsd, { threshold = 50, fee = 2 } = {}) {
  return Number(amountUsd) >= threshold ? fee : 0;
}
/** sender sends `send`, receiver gets `receive`, difference is the fee. */
export function calcTotals(amountUsd, feeUsd, payer) {
  const a = cents(amountUsd), f = cents(feeUsd);
  if (f === 0) return { fee: '0.00', send: usd(a), receive: usd(a) };
  if (!FEE_PAYERS.includes(payer)) throw new Error('fee payer required');
  const senderPays = payer === 'sender' ? f : payer === 'split' ? Math.ceil(f / 2) : 0;
  return { fee: usd(f), send: usd(a + senderPays), receive: usd(a - (f - senderPays)) };
}
