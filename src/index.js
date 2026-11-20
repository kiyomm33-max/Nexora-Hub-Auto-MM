import path from 'node:path';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { loadConfig } from './config.js';
import { log } from './logger.js';
import { openDb } from './db/index.js';
import { DealService } from './core/deals.js';
import { RateLimiter } from './core/ratelimit.js';
import { selectProvider } from './providers/index.js';
import { createServer } from './web/server.js';
import { scheduleBackups } from './jobs/backup.js';
import { audit } from './core/audit.js';
import { recoverReleases } from './discord/automm.js';
import { scheduleIdleCloser } from './jobs/idle.js';
import { route } from './discord/handlers.js';
import { syncDeal, publishCompleted } from './discord/rooms.js';
import { registerCommands } from './discord/register.js';

const cfg = loadConfig();
cfg.warnings.forEach((w) => log.warn(w));
const { provider, mode } = selectProvider(cfg);
cfg.mode = mode;
log.info(`Nexora Hub starting in ${mode.toUpperCase()} mode`, { provider: provider.name });

const db = openDb(path.join(cfg.dataDir, 'nexora.sqlite'));
const deals = new DealService(db, { mode });
const limiter = new RateLimiter();
setInterval(() => limiter.sweep(), 600e3).unref();
audit(db, { category: 'system', actor: 'system', action: 'bot.started', detail: { mode } });
scheduleBackups(db, cfg);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const ctx = { cfg, db, deals, provider, mode, limiter, client };
let ready = false;
const hasToken = !!cfg.token;

// Serialise Discord-side effects so status edits never race.
let chain = Promise.resolve();
deals.on('update', (deal, change) => {
  chain = chain.then(() => syncDeal(ctx, deal, change)).catch((e) => log.error('syncDeal failed', e));
});

createServer({ cfg, db, deals, mode, health: () => ({ discordReady: hasToken ? ready : undefined, discord: hasToken ? undefined : 'disabled (no DISCORD_TOKEN)' }) })
  .listen(cfg.port, '0.0.0.0', () => log.info(`HTTP listening on :${cfg.port}`));

if (hasToken) {
  client.on(Events.InteractionCreate, (i) => route(i, ctx));
  client.on(Events.Error, (e) => log.error('discord client error', e));
  client.once(Events.ClientReady, async () => {
    ready = true; log.info('Discord ready', { tag: client.user.tag });
    try { await registerCommands(cfg); } catch (e) { log.error('command registration failed', e); }
    recoverReleases(ctx); scheduleIdleCloser(ctx);
    for (const d of db.prepare("SELECT * FROM deals WHERE status='completed' AND completed_message_id IS NULL").all()) await publishCompleted(ctx, d).catch((e) => log.error('republish failed', e));
  });
  client.login(cfg.token).catch((e) => { log.error('discord login failed', e); process.exit(1); });
} else log.warn('DISCORD_TOKEN not set: running HTTP/health only');

// Fail fast on unknown errors so Railway restarts the process.
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
process.on('uncaughtException', (e) => { log.error('uncaughtException', e); process.exit(1); });
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { log.info(`${s}: shutting down`); try { db.close(); } catch {} process.exit(0); });
