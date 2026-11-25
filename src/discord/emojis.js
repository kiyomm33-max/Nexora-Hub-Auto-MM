// Coin icons as application emojis: uploaded once from assets/coins, then cached by name.
import { readFileSync, existsSync } from 'node:fs';
import { log } from '../logger.js';

const ICONS = ['btc', 'eth', 'ltc', 'sol', 'usdt', 'usdc'];
export const emojiMap = new Map();
/** Emojis of the Nexora server by name (e.g. hourglass), so they can be used without hard-coding every ID. */
export const guildEmoji = new Map();
export async function syncGuildEmojis(client, guildId) {
  const g = await client.guilds.fetch(guildId); const all = await g.emojis.fetch();
  for (const e of all.values()) guildEmoji.set(e.name, `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`);
  log.info('server emojis loaded', { count: guildEmoji.size });
}

export async function syncEmojis(client) {
  const have = await client.application.emojis.fetch();
  for (const name of ICONS) {
    const full = `nx_${name}`;
    let e = have.find((x) => x.name === full);
    const file = new URL(`../../assets/coins/${name}.png`, import.meta.url);
    if (!e && existsSync(file)) {
      try { e = await client.application.emojis.create({ attachment: readFileSync(file), name: full }); }
      catch (err) { log.error('emoji upload failed', { name, err: String(err) }); }
    }
    if (e) emojiMap.set(name.toUpperCase(), `<:${e.name}:${e.id}>`);
  }
  log.info('coin emojis ready', { count: emojiMap.size });
}
