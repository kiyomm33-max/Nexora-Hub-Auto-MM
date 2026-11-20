import { log } from '../logger.js';
import { audit } from '../core/audit.js';
import * as rooms from '../discord/rooms.js';

export const IDLE_MS = 30 * 60 * 1000;
/** Close deals still in setup with no activity for 30 minutes. Never touches deals with a provider escrow. */
export async function closeIdleDeals(ctx, now = Date.now()) {
  const cutoff = new Date(now - IDLE_MS).toISOString();
  const rows = ctx.db.prepare("SELECT * FROM deals WHERE status='waiting_parties' AND updated_at < ?").all(cutoff);
  for (const d of rows) {
    try {
      ctx.deals.cancel(d.id, 'system', 'idle for 30 minutes during setup', { staff: true });
      const ch = await rooms.fetchChannel(ctx, d.channel_id);
      if (ch) {
        await ch.send({ content: 'This ticket was left unattended for 30 minutes and is being closed.', allowedMentions: { parse: [] } }).catch(() => {});
        await rooms.saveTranscript(ctx, d.id, ch, 'system').catch((e) => log.error('idle transcript failed', e));
        setTimeout(() => ch.delete('Idle deal closed').catch(() => {}), 5000).unref?.();
      }
    } catch (e) { log.error('idle close failed', { id: d.id, err: e }); }
  }
  return rows.length;
}
export const scheduleIdleCloser = (ctx) => setInterval(() => closeIdleDeals(ctx).catch((e) => log.error('idle job', e)), 60e3).unref();
