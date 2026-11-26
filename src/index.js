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
import { sendWelcome } from './discord/welcome.js';
import { pingNewMember } from './discord/joinping.js';
import { seedPause } from './core/pause.js';
import { giveAutoRole, sweepAutoRole } from './discord/autorole.js';
import { commandFromMessage } from './discord/prefix.js';
import { countFromMessage, startActivity } from './discord/activity.js';
import { startStatusLoop } from './discord/status.js';
import { startGiveawayLoop } from './discord/giveaway.js';
import { startPollLoop } from './discord/poll.js';
import { startTotalsLoop } from './discord/totals.js';
import { startInvites } from './discord/invites.js';
import { recoverReleases, partnerFromMessage, payoutFromMessage, refundFromMessage } from './discord/automm.js';
import { scheduleIdleCloser } from './jobs/idle.js';
import { route } from './discord/handlers.js';
import { addressFromMessage as statusAddressFromMessage } from './discord/status.js';
import { syncDeal, publishCompleted, refreshStatus } from './discord/rooms.js';
import { registerCommands } from './discord/register.js';

const cfg = loadConfig();
cfg.warnings.forEach((w) => log.warn(w));
const db = openDb(path.join(cfg.dataDir, 'nexora.sqlite'));
const { provider, mode } = selectProvider(cfg, db);
cfg.mode = mode;
log.info(`Nexora Hub starting in ${mode.toUpperCase()} mode`, { provider: provider.name, ...(mode === 'live' ? { ltcNetwork: cfg.ltc.network } : {}) });
const deals = new DealService(db, { mode });
const limiter = new RateLimiter();
setInterval(() => limiter.sweep(), 600e3).unref();
audit(db, { category: 'system', actor: 'system', action: 'bot.started', detail: { mode } });
scheduleBackups(db, cfg);

let client;
const ctx = { cfg, db, deals, provider, mode, limiter, client: null };
let ready = false;
const hasToken = !!cfg.token;

// Serialise Discord-side effects so status edits never race.
let chain = Promise.resolve();
deals.on('update', (deal, change) => {
  chain = chain.then(() => syncDeal(ctx, deal, change)).catch((e) => log.error('syncDeal failed', e));
});

createServer({ cfg, db, deals, mode, health: () => ({ discordReady: hasToken ? ready : undefined, discord: hasToken ? undefined : 'disabled (no DISCORD_TOKEN)' }) })
  .listen(cfg.port, '0.0.0.0', () => log.info(`HTTP listening on :${cfg.port}`));

// level 3 = Guilds + Messages + Message Content + Server Members + Presences (status tracking); 2 = without Presences; 1 = without Server Members; 0 = Guilds only.
function boot(level) {
  const withMessages = level >= 1;
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildInvites, ...(withMessages ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] : []), ...(level >= 2 ? [GatewayIntentBits.GuildMembers] : []), ...(level >= 3 ? [GatewayIntentBits.GuildPresences] : [])];
  client = new Client({ intents });
  ctx.client = client; cfg.messageContent = withMessages;
  if (level >= 2) client.on(Events.GuildMemberAdd, (m) => { sendWelcome(ctx, m).catch((e) => log.error('welcome failed', e)); pingNewMember(ctx, m).catch((e) => log.error('join ping failed', e)); giveAutoRole(ctx, m).catch((e) => log.error('auto role failed', e)); });
  if (withMessages) client.on(Events.MessageCreate, (m) => { countFromMessage(m, ctx); return Promise.all([commandFromMessage(m, ctx), partnerFromMessage(m, ctx), payoutFromMessage(m, ctx), refundFromMessage(m, ctx), statusAddressFromMessage(m, ctx)]).catch((e) => log.error('message handler failed', e)); });
  ctx.presenceTracking = level >= 3; ctx.intentLevel = level;
  log.info(level >= 3 ? 'status tracking ON (Server Members and Presence intents are enabled)' : `status tracking OFF: the bot connected without ${level >= 2 ? 'the Presence intent' : 'the Server Members and Presence intents'}. Turn them on in the Discord Developer Portal (Bot > Privileged Gateway Intents).`);
  startStatusLoop(client, ctx);
  startGiveawayLoop(client, ctx);
  startPollLoop(client, ctx);
  startTotalsLoop(client, ctx);
  startInvites(client, ctx);
  startActivity(client, ctx, { members: level >= 2, presences: level >= 3 });
  client.on(Events.InteractionCreate, (i) => route(i, ctx));
  client.on(Events.Error, (e) => log.error('discord client error', e));
  client.once(Events.ClientReady, async () => {
    ready = true; log.info('Discord ready', { tag: client.user.tag });
    try { // set the bot avatar from assets/logo.png once per logo change (Discord rate-limits avatar edits)
      const { readFileSync, existsSync, writeFileSync } = await import('node:fs'); const { createHash } = await import('node:crypto');
      const logo = new URL('../assets/logo.png', import.meta.url); const mark = `${cfg.dataDir ?? process.env.DATA_DIR ?? './data'}/avatar.hash`;
      if (existsSync(logo)) { const buf = readFileSync(logo); const h = createHash('sha256').update(buf).digest('hex');
        if (!existsSync(mark) || readFileSync(mark, 'utf8') !== h) { await client.user.setAvatar(buf); writeFileSync(mark, h); log.info('bot avatar updated'); } }
    } catch (e) { log.error('avatar update failed', e); }
    try { (await import('./discord/emojis.js')).syncEmojis(client).catch((e) => log.error('emoji sync failed', e)); } catch (e) { log.error('emoji import failed', e); }
    try { (await import('./discord/emojis.js')).syncGuildEmojis(client, cfg.guildId).catch((e) => log.error('server emoji sync failed', e)); } catch (e) { log.error('emoji import failed', e); }
    try { ctx.guildOwnerId = (await client.guilds.fetch(cfg.guildId)).ownerId; log.info('guild owner resolved'); } catch (e) { log.error('could not fetch guild owner (check GUILD_ID)', e); }
    try { await registerCommands(cfg, { clear: cfg.messageContent && !cfg.slashCommands }); if (cfg.messageContent && !cfg.slashCommands) log.info('only /giveaway and /poll are slash commands; the rest use the prefix', { prefix: cfg.prefix }); } catch (e) { log.error('command registration failed', e); }
    recoverReleases(ctx); scheduleIdleCloser(ctx);
    try { if (seedPause(db, '2026-11-25-12h', 12 * 3600e3)) log.info('welcome message and join ping paused for 12 hours'); } catch (e) { log.error('pause seed failed', e); }
    if (level >= 2) import('./discord/trustroles.js').then((m) => m.sweepTrustRoles(ctx)).then((r) => log.info('trust roles synced', r)).catch((e) => log.error('trust role sweep failed', e));
    if (level >= 2 && cfg.autoRoleId) client.guilds.fetch(cfg.guildId).then((g) => sweepAutoRole(ctx, g)).catch((e) => log.error('auto role sweep failed', e));
    // After a restart, put the live status message (with its buttons) back at the bottom of rooms that are waiting on a person.
    for (const d of db.prepare("SELECT * FROM deals WHERE status='verification_pending' AND mode='live' AND escrow_status='provider_confirmed' AND release_at IS NULL AND (released_at IS NULL OR payout_address IS NULL)").all()) await refreshStatus(ctx, d, { bump: true }).catch((e) => log.error('status repost failed', e));
    if (provider.live) provider.start((ev) => { try { deals.applyProviderEvent(ev); } catch (e) { log.error('applyProviderEvent failed', e); } });
    for (const d of db.prepare("SELECT * FROM deals WHERE status='completed' AND completed_message_id IS NULL").all()) await publishCompleted(ctx, d, { force: true }).catch((e) => log.error('republish failed', e));
  });
  client.login(cfg.token).catch((e) => {
    if (level > 0 && /disallowed intents/i.test(String(e?.message))) {
      log.warn(level === 3 ? 'Presence intent is not enabled in the Discord Developer Portal; the .gg status tracking is off until you enable it' : level === 2 ? 'Server Members intent is not enabled in the Discord Developer Portal; the welcome message and tag tracking are off until you enable it' : 'Message Content intent is not enabled in the Discord Developer Portal; falling back to the user ID button');
      client.destroy(); boot(level - 1); return;
    }
    log.error('discord login failed', e); process.exit(1);
  });
}
if (hasToken) boot(3); else log.warn('DISCORD_TOKEN not set: running HTTP/health only');

// Fail fast on unknown errors so Railway restarts the process.
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
process.on('uncaughtException', (e) => { log.error('uncaughtException', e); process.exit(1); });
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { log.info(`${s}: shutting down`); try { db.close(); } catch {} process.exit(0); });
