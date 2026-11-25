// EUR per 1 USD for the "Euros" price option. Two free sources, cached for 10 minutes.
let cache = { at: 0, v: 0 };
export async function eurPerUsd(fetchFn = fetch) {
  if (cache.v && Date.now() - cache.at < 600e3) return cache.v;
  const sources = [
    async () => (await (await fetchFn('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR', { signal: AbortSignal.timeout(8000) })).json()).rates.EUR,
    async () => (await (await fetchFn('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) })).json()).rates.EUR,
  ];
  for (const s of sources) { try { const v = Number(await s()); if (v > 0.1 && v < 10) { cache = { at: Date.now(), v }; return v; } } catch { /* next source */ } }
  if (cache.v) return cache.v; // an old rate beats none
  const e = new Error('Could not fetch the EUR rate right now. Try again in a minute.'); e.userFacing = true; throw e;
}
