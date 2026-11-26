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

export const FINISHED_MS = 5 * 60 * 1000;
/** Remove the room of a completed or cancelled deal 5 minutes after it ended (transcript saved first). */
export async function closeFinishedRooms(ctx, now = Date.now()) {
  const cutoff = new Date(now - FINISHED_MS).toISOString();
  const rows = ctx.db.prepare("SELECT * FROM deals WHERE status IN ('completed','cancelled') AND channel_id IS NOT NULL AND COALESCE(completed_at, cancelled_at) < ? AND COALESCE(completed_at, cancelled_at) > ?")
    .all(cutoff, new Date(now - 7 * 864e5).toISOString());
  let n = 0;
  for (const d of rows) {
    try {
      const ch = await rooms.fetchChannel(ctx, d.channel_id);
      if (!ch) continue; // already removed
      if (!ctx.db.prepare('SELECT 1 FROM transcripts WHERE ticket_id=?').get(d.id)) await rooms.saveTranscript(ctx, d.id, ch, 'system');
      audit(ctx.db, { actor: 'system', action: 'room.auto_closed', dealId: d.id, detail: { after: '5 minutes' } });
      await ch.delete('Deal ended 5 minutes ago');
      n++;
    } catch (e) { log.error(`finished room close failed for ${d.id}: ${e?.message ?? e}`); }
  }
  return n;
}
export const scheduleIdleCloser = (ctx) => setInterval(() => { closeIdleDeals(ctx).catch((e) => log.error('idle job', e)); closeFinishedRooms(ctx).catch((e) => log.error('finished-room job', e)); }, 60e3).unref();
