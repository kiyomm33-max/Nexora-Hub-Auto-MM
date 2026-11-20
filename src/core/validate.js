// Strict input validation. Every user-supplied string passes through here.
export class ValidationError extends Error {}

export const SUPPORTED = {
  BTC: ['bitcoin', 'lightning'],
  LTC: ['litecoin'],
  ETH: ['ethereum', 'base', 'arbitrum'],
  USDT: ['tron', 'ethereum', 'bsc'],
  USDC: ['ethereum', 'base', 'solana'],
  SOL: ['solana'],
};
const NETWORK_ALIAS = { btc: 'bitcoin', ltc: 'litecoin', eth: 'ethereum', erc20: 'ethereum', trc20: 'tron', trx: 'tron', bep20: 'bsc', bnb: 'bsc', sol: 'solana', ln: 'lightning' };
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'];

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, '').trim();

export function robloxName(s) {
  const v = clean(s);
  if (!/^[A-Za-z0-9_]{3,20}$/.test(v) || v.startsWith('_') || v.endsWith('_') || (v.match(/_/g) || []).length > 1)
    throw new ValidationError(`"${v.slice(0, 25)}" is not a valid Roblox username (3-20 letters, numbers, one underscore max).`);
  return v;
}
export function text(s, { min = 1, max = 200, label = 'Text' } = {}) {
  const v = clean(s).replace(/@(everyone|here)/gi, '@\u200b$1').replace(/<@[!&]?\d+>/g, '[mention]');
  if (v.length < min || v.length > max) throw new ValidationError(`${label} must be ${min}-${max} characters.`);
  return v;
}
export function value(s) {
  const m = clean(s).toUpperCase().match(/^(\d{1,9}(?:\.\d{1,2})?)\s*([A-Z]{3})$/);
  if (!m || Number(m[1]) <= 0) throw new ValidationError('Value must look like `25.00 USD`.');
  if (!CURRENCIES.includes(m[2])) throw new ValidationError(`Supported currencies: ${CURRENCIES.join(', ')}.`);
  return { amount: m[1], currency: m[2] };
}
export function crypto(s) {
  const parts = clean(s).toLowerCase().split(/[\s/,:-]+/).filter(Boolean);
  const asset = (parts[0] || '').toUpperCase();
  const nets = SUPPORTED[asset];
  if (!nets) throw new ValidationError(`Unsupported crypto. Supported: ${Object.entries(SUPPORTED).map(([a, n]) => `${a} (${n.join('/')})`).join(', ')}.`);
  let net = parts[1] ? (NETWORK_ALIAS[parts[1]] || parts[1]) : (nets.length === 1 ? nets[0] : null);
  if (!net || !nets.includes(net)) throw new ValidationError(`${asset} networks: ${nets.join(', ')}. Example: \`${asset} ${nets[0]}\`.`);
  return { asset, network: net };
}
export function usdAmount(s) {
  const m = clean(s).replace(/^\$/, '').replace(/\s*(usd)?$/i, '').match(/^(\d{1,6}(?:\.\d{1,2})?)$/);
  const n = m ? Number(m[1]) : NaN;
  if (!(n >= 1 && n <= 100000)) throw new ValidationError('Enter the deal amount in USD between 1 and 100000, e.g. `20` or `20.50`.');
  return n.toFixed(2);
}
export function rating(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > 5) throw new ValidationError('Rating must be a whole number from 1 to 5.');
  return v;
}
export const snowflake = (s) => { if (!/^\d{15,22}$/.test(String(s))) throw new ValidationError('Invalid Discord ID.'); return String(s); };
export function dealId(s) {
  const v = clean(s).toUpperCase();
  if (!/^NXH-[0-9A-Z]{8}$/.test(v)) throw new ValidationError('Deal IDs look like `NXH-AB12CD34`.');
  return v;
}
export function evidenceUrl(s) {
  if (!s) return null;
  let u; try { u = new URL(clean(s)); } catch { throw new ValidationError('Evidence link is not a valid URL.'); }
  if (u.protocol !== 'https:') throw new ValidationError('Evidence links must use https.');
  return u.toString().slice(0, 500);
}

const B58 = '[1-9A-HJ-NP-Za-km-z]';
const ADDR = {
  BTC: new RegExp(`^(bc1[a-z0-9]{25,60}|[13]${B58}{25,34})$`),
  LTC: new RegExp(`^(t?ltc1[a-z0-9]{25,60}|[LM3mn2]${B58}{26,33})$`),
  EVM: /^0x[0-9a-fA-F]{40}$/,
  SOL: new RegExp(`^${B58}{32,44}$`),
};
/** Format check only (no checksum). The provider performs the authoritative validation. */
export function payoutAddress(asset, network, s) {
  const v = clean(s);
  const kind = asset === 'BTC' ? 'BTC' : asset === 'LTC' ? 'LTC' : network === 'solana' ? 'SOL' : 'EVM';
  if (!ADDR[kind].test(v)) throw new ValidationError(`That does not look like a valid ${asset} address on ${network}. Check it and try again.`);
  return v;
}
