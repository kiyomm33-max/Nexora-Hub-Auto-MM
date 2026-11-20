// End-to-end flow through the real handlers + HTTP webhook, using fake Discord objects.
// This does NOT prove behaviour against the live Discord API (needs a real token and guild).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db/index.js';
import { DealService } from '../src/core/deals.js';
import { RateLimiter } from '../src/core/ratelimit.js';
import { DemoProvider } from '../src/providers/demo.js';
import { loadConfig } from '../src/config.js';
import { route } from '../src/discord/handlers.js';
import { fireRelease } from '../src/discord/automm.js';
import { syncDeal, refreshStatus } from '../src/discord/rooms.js';
import { createServer } from '../src/web/server.js';
import { sign } from '../src/providers/signature.js';
import { verifyAuditChain } from '../src/core/audit.js';

const A = '111111111111111111', B = '222222222222222222', MM = '333333333333333333', SUP = '444444444444444444', ADM = '555555555555555555', RND = '666666666666666666', TRIAL = '777777777777777777';
const BOT = '888888888888888888';
const ROLE = { mm: 'r-mm', sup: 'r-sup', adm: 'r-adm', trial: 'r-trial' };

function setup() {
  const cfg = loadConfig({ GUILD_ID: 'g', COMPLETED_CHANNEL_ID: 'completed', VOUCH_CHANNEL_ID: 'vouches', STAFF_LOG_CHANNEL_ID: 'slog', TRANSCRIPT_CHANNEL_ID: 'tr', PROVIDER_WEBHOOK_SECRET: 'whsec',
    ROLE_ADMIN_IDS: ROLE.adm, ROLE_MIDDLEMAN_IDS: ROLE.mm, ROLE_SUPPORT_IDS: ROLE.sup, ROLE_TRIAL_IDS: ROLE.trial, DATA_DIR: '/tmp/nx-flow' });
  const db = openDb(':memory:'); const deals = new DealService(db, { mode: 'demo' });
  const chans = new Map(); let seq = 0;
  const mkChan = (id, name) => { const c = { id, name, sent: [], msgs: new Map(), deleted: false, perms: [], permissionOverwrites: { edit: async (id, o) => { c.perms.push([id, o]); } },
    async send(p) { const m = { id: `m${++seq}`, ...p, edit: async (x) => Object.assign(m, x) }; c.sent.push(m); c.msgs.set(m.id, m); return m; },
    messages: { fetch: async (a) => (typeof a === 'string' ? c.msgs.get(a) : (() => { const col = new Map(); return Object.assign(col, { last: () => null }); })()) },
    delete: async () => { c.deleted = true; } }; chans.set(id, c); return c; };
  for (const id of ['completed', 'vouches', 'slog', 'tr']) mkChan(id, id);
  const guild = { ownerId: 'owner', roles: { everyone: { id: 'ev' } }, members: { me: { id: 'bot' }, fetch: async (id) => { if (id === '000000000000000000') throw new Error('unknown'); return { user: { bot: id === BOT } }; } }, channels: { create: async (o) => { const c = mkChan(`c${++seq}`, o.name); c.opts = o; return c; } } };
  const client = { channels: { fetch: async (id) => { const c = chans.get(id); if (!c || c.deleted) throw new Error('nf'); return c; } }, guilds: { fetch: async () => guild }, users: { fetch: async (id) => ({ username: `user${id.slice(0, 3)}` }) } };
  const limiter = new RateLimiter(); const check = limiter.check.bind(limiter); limiter.check = (k, ...r) => (k.startsWith('global:') && !process.env.TEST_GLOBAL_LIMIT ? { ok: true } : check(k, ...r));
  const ctx = { cfg, db, deals, provider: new DemoProvider(), mode: 'demo', limiter, client };
  let chain = Promise.resolve(); deals.on('update', (d, c) => { chain = chain.then(() => syncDeal(ctx, d, c)); });
  ctx.settle = () => chain;
  ctx.guild = guild; ctx.chans = chans; return ctx;
}
function fake(ctx, kind, user, { roles = [], customId, command, sub, opts = {}, fields = {}, channel, values } = {}) {
  const i = { user: { id: user }, member: { roles: { cache: new Map(roles.map((r) => [r, 1])) } }, guild: ctx.guild, customId, commandName: command, channel: channel ?? ctx.chans.get('lobby') ?? (ctx.chans.set('lobby', { id: 'lobby', sent: [], async send(p) { this.sent.push(p); } }), ctx.chans.get('lobby')),
    out: [], modal: null, deferred: false, replied: false,
    isChatInputCommand: () => kind === 'cmd', isButton: () => kind === 'btn', isModalSubmit: () => kind === 'modal', isUserSelectMenu: () => kind === 'select', values,
    options: { getUser: (k) => opts[k], getString: (k) => opts[k], getInteger: (k) => opts[k], getAttachment: (k) => opts[k], getSubcommand: () => sub },
    fields: { getTextInputValue: (k) => fields[k] ?? '' }, users: { first: () => opts.user },
    reply: async (p) => { i.replied = true; i.out.push(p); }, followUp: async (p) => { i.out.push(p); }, update: async (p) => { i.out.push(p); },
    deferReply: async () => { i.deferred = true; }, deferUpdate: async () => { i.deferred = true; }, editReply: async (p) => { i.out.push(p); },
    showModal: async (m) => { i.modal = m; } };
  return i;
}
const text = (i) => JSON.stringify(i.out.map((o) => [o.content, ...(o.embeds ?? []).map((e) => [e.data.title, e.data.description, ...(e.data.fields ?? []).map((f) => f.value)])]));
const modalFields = { roblox_you: 'Alice_1', roblox_partner: 'Bob22', item: 'Dominus', value: '25.00 USD', crypto: 'LTC litecoin' };

const click = async (ctx, user, customId, extra = {}) => { const ch = ctx.chans.get(ctx.room); const i = fake(ctx, 'btn', user, { customId, channel: ch, ...extra }); await route(i, ctx); return i; };
const submit = async (ctx, user, customId, fields) => { const i = fake(ctx, 'modal', user, { customId, fields, channel: ctx.chans.get(ctx.room) }); await route(i, ctx); return i; };
async function startDeal(ctx, key = 'LTC', user = A) {
  const i = fake(ctx, 'btn', user, { customId: `nx:am-start:${key}` }); await route(i, ctx);
  const d = ctx.db.prepare('SELECT * FROM deals ORDER BY created_at DESC, rowid DESC LIMIT 1').get(); ctx.room = d.channel_id; return { i, d };
}
/** Walk the whole setup flow with real handlers. Returns deal id. */
async function runToRoom(ctx, { amount = '20', feeChoice = 'receiver' } = {}) {
  const { d } = await startDeal(ctx); const id = d.id; const ch = ctx.chans.get(ctx.room);
  const sel = async (u, cid, extra) => { const i = fake(ctx, 'select', u, { customId: cid, channel: ch, ...extra }); await route(i, ctx); return i; };
  await sel(A, `nx:am-type:${id}`, { values: ['robux'] });
  await sel(A, `nx:am-partner:${id}`, { opts: { user: { id: B } }, values: [] });
  await click(ctx, A, `nx:am-role:${id}:sender`); await click(ctx, B, `nx:am-role:${id}:receiver`);
  await submit(ctx, A, `nx:am-descmodal:${id}`, { desc: '20k Robux for $20 of LTC' });
  await click(ctx, B, `nx:am-accept:${id}`);
  await submit(ctx, B, `nx:am-amountmodal:${id}`, { amount });
  await click(ctx, A, `nx:am-amtok:${id}`); await click(ctx, B, `nx:am-amtok:${id}`);
  if (Number(amount) >= 50) { await click(ctx, A, `nx:am-fee:${id}:${feeChoice}`); await click(ctx, B, `nx:am-fee:${id}:${feeChoice}`); }
  return id;
}

test('panel is a Components V2 message with a Start button per coin; posted to the panel channel', async () => {
  const ctx = setup(); ctx.cfg.channels.panel = 'panelch'; ctx.chans.set('panelch', { id: 'panelch', sent: [], async send(p) { this.sent.push(p); } });
  const i = fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'panel' }); await route(i, ctx);
  const p = ctx.chans.get('panelch').sent[0]; assert.equal(p.flags & 32768, 32768);
  const json = JSON.stringify(p.components.map((c) => c.toJSON()));
  for (const k of ['BTC', 'ETH', 'LTC', 'SOL', 'USDT-ERC20', 'USDC-ERC20', 'USDT-BEP20']) assert.ok(json.includes(`nx:am-start:${k}`), k);
  const deny = fake(ctx, 'cmd', RND, { command: 'panel' }); await route(deny, ctx); assert.match(text(deny), /do not have permission/);
});

test('start: private room with Deal Started + Safety Warning + Close + deal type dropdown; max 2 open deals', async () => {
  const ctx = setup(); const { d } = await startDeal(ctx, 'USDT-BEP20');
  assert.equal(d.status, 'waiting_parties'); assert.equal(d.network, 'bsc');
  const room = ctx.chans.get(d.channel_id);
  assert.ok(room.opts.permissionOverwrites.some((o) => o.deny && o.id === 'ev'));
  assert.ok(room.opts.permissionOverwrites.some((o) => o.id === A) && !room.opts.permissionOverwrites.some((o) => o.id === ROLE.trial));
  assert.match(JSON.stringify(room.sent[0].embeds.map((e) => e.data)), /Deal Started[\s\S]*Safety Warning[\s\S]*NEVER/);
  assert.match(JSON.stringify(room.sent[0].components.map((c) => c.toJSON())), /nx:am-close/);
  const sel = JSON.stringify(room.sent[1].components.map((c) => c.toJSON()));
  for (const t of ['In-Game', 'Exchange', 'Counter Strike', 'Robux', 'Other']) assert.ok(sel.includes(t), t);
  await startDeal(ctx, 'BTC'); const third = fake(ctx, 'btn', A, { customId: 'nx:am-start:ETH' }); await route(third, ctx); assert.match(text(third), /2 open deals/);
});

test('setup: steps are ordered, only the right person can act, bad input rejected', async () => {
  const ctx = setup(); const { d } = await startDeal(ctx); const id = d.id; const ch = ctx.chans.get(ctx.room);
  const sel = async (u, cid, extra) => { const i = fake(ctx, 'select', u, { customId: cid, channel: ch, ...extra }); await route(i, ctx); return i; };
  assert.match(text(await click(ctx, A, `nx:am-role:${id}:sender`)), /already done|not available/); // skipping steps
  assert.match(text(await sel(B, `nx:am-type:${id}`, { values: ['robux'] })), /Only the traders|Only the deal creator/);
  assert.match(text(await sel(A, `nx:am-type:${id}`, { values: ['hax'] })), /Invalid deal type/);
  await sel(A, `nx:am-type:${id}`, { values: ['in-game'] });
  assert.match(text(await sel(A, `nx:am-partner:${id}`, { opts: { user: { id: A } }, values: [] })), /yourself/);
  assert.match(text(await sel(A, `nx:am-partner:${id}`, { opts: { user: { id: BOT } }, values: [] })), /Bots/);
  const typed = fake(ctx, 'modal', A, { customId: `nx:am-partnermodal:${id}`, fields: { uid: '<@' + B + '>' }, channel: ch }); await route(typed, ctx); // add by ID/ping
  assert.equal(ctx.deals.get(id).party_b, B); assert.ok(ch.perms.some(([u]) => u === B), 'partner granted channel access');
  assert.match(text(await click(ctx, RND, `nx:am-role:${id}:sender`)), /Only the two traders/);
  await click(ctx, A, `nx:am-role:${id}:sender`);
  assert.match(text(await click(ctx, B, `nx:am-role:${id}:sender`)), /already taken/);
  await click(ctx, A, `nx:am-rolereset:${id}`); assert.deepEqual(ctx.deals.setup(ctx.deals.get(id)).votes, {});
  await click(ctx, B, `nx:am-role:${id}:sender`); await click(ctx, A, `nx:am-role:${id}:receiver`);
  const r = ctx.deals.get(id); assert.equal(r.sender_id, B); assert.equal(r.receiver_id, A);
  await submit(ctx, B, `nx:am-descmodal:${id}`, { desc: 'He is giving me 20k Robux for $20 LTC' });
  assert.match(text(await click(ctx, B, `nx:am-accept:${id}`)), /other trader has to accept/);
  await click(ctx, A, `nx:am-decline:${id}`); assert.equal(ctx.deals.setup(ctx.deals.get(id)).step, 'describe'); assert.equal(ctx.deals.get(id).item, '');
  await submit(ctx, A, `nx:am-descmodal:${id}`, { desc: 'Second description attempt' }); await click(ctx, B, `nx:am-accept:${id}`);
  for (const bad of ['abc', '0', '-5', '1e3', '999999999']) assert.match(text(await submit(ctx, A, `nx:am-amountmodal:${id}`, { amount: bad })), /between 1 and 100000/);
  await submit(ctx, A, `nx:am-amountmodal:${id}`, { amount: '$20' }); assert.equal(ctx.deals.get(id).amount, '20.00');
  await click(ctx, A, `nx:am-amtno:${id}`); assert.equal(ctx.deals.setup(ctx.deals.get(id)).step, 'amount');
  await submit(ctx, A, `nx:am-amountmodal:${id}`, { amount: '20' });
  await click(ctx, A, `nx:am-amtok:${id}`); assert.equal(ctx.deals.get(id).status, 'waiting_parties', 'one confirmation is not enough');
  await click(ctx, A, `nx:am-amtok:${id}`); assert.equal(ctx.deals.get(id).status, 'waiting_parties');
  await click(ctx, B, `nx:am-amtok:${id}`);
  const x = ctx.deals.get(id); assert.equal(x.status, 'awaiting_provider'); assert.equal(x.fee_usd, '0.00'); assert.equal(x.send_usd, '20.00'); assert.equal(x.receive_usd, '20.00');
  assert.match(x.pay_address, /^DEMO-NOT-A-REAL-ADDRESS/);
  assert.match(text(await click(ctx, A, `nx:am-amountmodal:${id}`)), /./); // no-op after activation
  assert.ok(verifyAuditChain(ctx.db).ok);
});

test('fee: under threshold none; over threshold both must agree on who pays (sender / receiver / split)', async () => {
  for (const [choice, send, recv] of [['sender', '102.00', '100.00'], ['receiver', '100.00', '98.00'], ['split', '101.00', '99.00']]) {
    const ctx = setup(); const id = await runToRoom(ctx, { amount: '100', feeChoice: choice });
    const d = ctx.deals.get(id); assert.equal(d.status, 'awaiting_provider'); assert.equal(d.fee_usd, '2.00'); assert.equal(d.fee_payer, choice);
    assert.equal(d.send_usd, send, `${choice} send`); assert.equal(d.receive_usd, recv, `${choice} receive`);
    const room = ctx.chans.get(d.channel_id); const last = JSON.stringify(room.sent.at(-1).embeds ?? room.msgs.get(d.status_message_id).embeds);
  }
  const ctx = setup(); const { d } = await startDeal(ctx); const id = d.id; const ch = ctx.chans.get(ctx.room);
  ctx.deals.patch(id, A, { party_b: B, sender_id: A, receiver_id: B, item: 'x trade', amount: '100.00', fee_usd: '2.00', setup: { step: 'fee', votes: {} } }, 'test');
  const sent = ch.sent.length; await click(ctx, A, `nx:am-fee:${id}:sender`); assert.equal(ctx.deals.get(id).status, 'waiting_parties');
  await click(ctx, B, `nx:am-fee:${id}:receiver`);
  assert.equal(ctx.deals.setup(ctx.deals.get(id)).step, 'fee'); assert.deepEqual(ctx.deals.setup(ctx.deals.get(id)).votes, {}); assert.ok(ch.sent.length > sent, 'mismatch notice sent');
  assert.match(text(await click(ctx, A, `nx:am-fee:${id}:free`)), /Invalid choice/);
  const at = fake(ctx, 'btn', RND, { customId: `nx:am-fee:${id}:split`, channel: ch }); await route(at, ctx); assert.match(text(at), /Only the two traders/);
});

const LTC = 'ltc1q35cyzmeksqxg8vjdlek4m94thpvdyj3meaydkz';
const payDb = (ctx, id) => ctx.db.prepare('UPDATE deals SET payout_address=? WHERE id=?').run(LTC, id);

test('invoice, transaction detected, payment received, release (confirm + 60s countdown), payout address, completion', async () => {
  const ctx = setup(); const id = await runToRoom(ctx, { amount: '2' }); const room = ctx.chans.get(ctx.room);
  const sim = async (event) => { const i = fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'staff', sub: 'simulate', opts: { deal_id: id, event } }); await route(i, ctx); await ctx.settle(); return text(i); };
  await refreshStatus(ctx, ctx.deals.get(id));
  const msg = () => room.msgs.get(ctx.deals.get(id).status_message_id);
  const status = () => JSON.stringify(msg().embeds.map((e) => e.data));
  const comps = () => JSON.stringify(msg().components.map((c) => c.toJSON()));
  // 1. Deal Summary + Payment Invoice (with QR)
  assert.match(status(), /Deal Summary[\s\S]*Sender[\s\S]*Receiver[\s\S]*Coin[\s\S]*Deal Amount[\s\S]*Payment Invoice[\s\S]*Address[\s\S]*Exchange Rate: 1 LTC = 41\.23 USD \(DEMO rate\)/);
  assert.match(status(), /DEMO-NOT-A-REAL-ADDRESS/); assert.match(status(), /0\.04850860|0\.0485/); assert.ok(msg().files.length === 1 && msg().files[0].name === 'qr.png', 'QR attached');
  assert.doesNotMatch(comps(), /am-release/);
  // 2. Transaction Detected
  await sim('funds.observed'); assert.match(status(), /Transaction Detected[\s\S]*Transaction[\s\S]*DEMO-TX[\s\S]*Amount Received[\s\S]*Required Confirmations/);
  assert.doesNotMatch(status(), /Payment Received|secured/); assert.equal(msg().files.length, 0, 'QR removed');
  const early = await click(ctx, A, `nx:am-release:${id}`); assert.match(text(early), /has not confirmed/);
  // 3. Payment Received + proceed + Release/Cancel
  await sim('escrow.funded'); assert.match(status(), /Payment Received[\s\S]*secured[\s\S]*You may now proceed with the deal[\s\S]*Release/);
  assert.match(comps(), /nx:am-release/); assert.doesNotMatch(comps(), /dispute|cancelpaid/);
  assert.match(text(await click(ctx, B, `nx:am-release:${id}`)), /Only the sender/);
  assert.match(text(await click(ctx, RND, `nx:am-release:${id}`)), /Only the sender/);
  const ask = await click(ctx, A, `nx:am-release:${id}`); assert.match(text(ask), /Are you sure/); assert.equal(ctx.deals.get(id).release_at, null, 'asking does not release');
  await click(ctx, A, `nx:am-relno:${id}`); assert.equal(ctx.deals.get(id).release_at, null);
  assert.match(text(await click(ctx, B, `nx:am-relyes:${id}`)), /Only the sender/);
  const t0 = Date.now(); await click(ctx, A, `nx:am-relyes:${id}`); await ctx.settle();
  const d = ctx.deals.get(id); const secs = (Date.parse(d.release_at) - t0) / 1000; assert.ok(secs > 59 && secs <= 60.5, `countdown ~60s (got ${secs})`);
  assert.match(JSON.stringify(room.sent.at(-1).embeds.map((e) => e.data)), /Release countdown[\s\S]*<t:\d+:R>/);
  assert.match(status(), /Release countdown/);
  assert.match(text(await click(ctx, B, `nx:am-relcancel:${id}`)), /Only the person who started/);
  await click(ctx, A, `nx:am-relcancel:${id}`); assert.equal(ctx.deals.get(id).release_at, null);
  assert.equal(await fireRelease(ctx, id), 'skipped', 'cancelled release never fires');
  ctx.cfg.releaseDelaySec = 1; await click(ctx, A, `nx:am-relyes:${id}`);
  assert.equal(await fireRelease(ctx, id), 'skipped', 'not due yet');
  await new Promise((r) => setTimeout(r, 1500)); await ctx.settle();
  // 4. Provide your address
  let x = ctx.deals.get(id); assert.ok(x.released_at); assert.equal(x.status, 'verification_pending', 'release alone does not complete the deal');
  assert.match(status(), /Send your Litecoin \(LTC\) address/); assert.match(comps(), /nx:am-payaddr/);
  assert.equal(ctx.chans.get('completed').sent.length, 0);
  assert.match(text(await click(ctx, A, `nx:am-payaddr:${id}`)), /Only the receiver/);
  const m = await click(ctx, B, `nx:am-payaddr:${id}`); assert.ok(m.modal);
  assert.match(text(await submit(ctx, B, `nx:am-payaddrmodal:${id}`, { addr: 'not-an-address' })), /valid LTC address/);
  assert.match(text(await submit(ctx, B, `nx:am-payaddrmodal:${id}`, { addr: '0x' + 'a'.repeat(40) })), /valid LTC address/);
  assert.match(text(await submit(ctx, A, `nx:am-payaddrmodal:${id}`, { addr: LTC })), /Only the receiver/);
  const conf = await submit(ctx, B, `nx:am-payaddrmodal:${id}`, { addr: LTC }); assert.match(text(conf), /Confirm your address[\s\S]*Payouts cannot be reversed/);
  assert.equal(ctx.deals.get(id).payout_address, null, 'nothing stored before confirmation');
  { const { payoutFromMessage } = await import('../src/discord/automm.js'); const room = ctx.chans.get(ctx.room); const replies = []; const before = room.sent.length; let deleted = 0;
    const msg = (author, content) => ({ author: { id: author, bot: false }, guild: ctx.guild, channel: room, channelId: room.id, content, reply: async (o) => { replies.push(o.content); }, delete: async () => { deleted++; } });
    await payoutFromMessage(msg(A, LTC), ctx); assert.equal(room.sent.length, before, 'only the receiver counts');
    await payoutFromMessage(msg(B, 'not-an-address'), ctx); assert.match(replies.at(-1), /valid LTC address/);
    await payoutFromMessage(msg(B, LTC), ctx); assert.equal(room.sent.length, before + 1); assert.equal(deleted, 1);
    assert.match(JSON.stringify(room.sent.at(-1).components.map((c) => c.toJSON())), new RegExp(`nx:am-payyes:${id}:${LTC}`)); assert.equal(ctx.deals.get(id).payout_address, null); }
  assert.match(text(await click(ctx, A, `nx:am-payyes:${id}:${LTC}`)), /Only the receiver/);
  await click(ctx, B, `nx:am-payyes:${id}:${LTC}`); await ctx.settle();
  x = ctx.deals.get(id); assert.equal(x.status, 'completed'); assert.equal(x.payout_address, LTC);
  assert.equal(ctx.chans.get('completed').sent.length, 1);
  assert.match(text(await click(ctx, B, `nx:am-payyes:${id}:${LTC}`)), /No payout address|already|Cannot|not released|payout/i);
  assert.equal(ctx.chans.get('completed').sent.length, 1);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='release.sent_to_provider'").get().n, 1);
  assert.ok(verifyAuditChain(ctx.db).ok);
});

test('dispute during the countdown stops the release', async () => {
  const ctx = setup(); const id = await runToRoom(ctx); ctx.cfg.releaseDelaySec = 1;
  for (const e of ['escrow.funded']) ctx.deals.applyProviderEvent({ id: 'f1', type: e, reference: ctx.deals.get(id).provider_ref }, { simulated: true });
  await click(ctx, A, `nx:am-relyes:${id}`);
  ctx.deals.dispute(id, B, 'sender is scamming me'); await ctx.settle();
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(ctx.deals.get(id).status, 'disputed'); assert.equal(ctx.deals.get(id).release_at, null);
});

test('close button: cancels unfunded deal and saves transcript; blocked once funds observed', async () => {
  const ctx = setup(); const id = await runToRoom(ctx);
  const out = await click(ctx, RND, `nx:am-close:${id}`); assert.match(text(out), /Only the traders and staff/);
  const ok = await click(ctx, B, `nx:am-close:${id}`); assert.match(text(ok), /Deal closed/);
  assert.equal(ctx.deals.get(id).status, 'cancelled'); assert.ok(ctx.db.prepare('SELECT 1 FROM transcripts WHERE ticket_id=?').get(id));
  const ctx2 = setup(); const id2 = await runToRoom(ctx2);
  ctx2.deals.applyProviderEvent({ id: 'o1', type: 'funds.observed', reference: ctx2.deals.get(id2).provider_ref }, { simulated: true });
  const no = await click(ctx2, A, `nx:am-close:${id2}`); assert.match(text(no), /provider/); assert.equal(ctx2.deals.get(id2).status, 'verification_pending');
});

test('staff permissions are enforced on every staff command/button', async () => {
  const ctx = setup(); const id = await runToRoom(ctx);
  const tryCmd = async (user, roles, sub, opts = {}, command = 'staff') => { const i = fake(ctx, 'cmd', user, { roles, command, sub, opts: { deal_id: id, reason: 'because', event: 'escrow.funded', ...opts } }); await route(i, ctx); return text(i); };
  for (const [sub] of [['history'], ['claim'], ['cancel'], ['simulate'], ['audit'], ['backup'], ['activity']]) {
    assert.match(await tryCmd(RND, [], sub), /do not have permission/, `member blocked from ${sub}`);
  }
  assert.match(await tryCmd(RND, [], null, {}, 'panel'), /do not have permission/);
  assert.match(await tryCmd(TRIAL, [ROLE.trial], 'history'), /do not have permission/);
  assert.match(await tryCmd(SUP, [ROLE.sup], 'claim'), /do not have permission/);
  assert.match(await tryCmd(SUP, [ROLE.sup], 'simulate'), /do not have permission/);
  assert.match(await tryCmd(MM, [ROLE.mm], 'cancel'), /do not have permission/);
  assert.match(await tryCmd(MM, [ROLE.mm], 'backup'), /do not have permission/);
  assert.match(await tryCmd(RND, [], 'history', {}, 'dealinfo'), /Only the participants/);
  assert.match(await tryCmd(SUP, [ROLE.sup], 'history'), /deal\.created|History/);
  assert.match(await tryCmd(MM, [ROLE.mm], 'claim'), /Deal claimed/);
  assert.match(await tryCmd(SUP, [ROLE.sup], 'claim'), /do not have permission/);
  assert.match(await tryCmd(ADM, [ROLE.adm], 'audit'), /Audit chain intact/);
  assert.match(await tryCmd(ADM, [ROLE.adm], 'activity', { member: { id: MM } }), /deal\.claimed/);
  assert.match(await tryCmd(SUP, [ROLE.sup], 'activity', { member: { id: MM } }), /do not have permission/);
  assert.match(await tryCmd(ADM, [ROLE.adm], 'backup'), /Backup created/);
  assert.match(await tryCmd(ADM, [ROLE.adm], null, {}, 'panel'), /Panel posted/);
  const denied = ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='permission.denied'").get().n; assert.ok(denied >= 10);
  // guild owner is Owner
  const o = fake(ctx, 'cmd', 'owner', { command: 'staff', sub: 'audit' }); await route(o, ctx); assert.match(text(o), /intact/);
});

test('full lifecycle: simulate provider -> completed -> published -> vouch', async () => {
  const ctx = setup(); const id = await runToRoom(ctx);
  const sim = async (event) => { const i = fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'staff', sub: 'simulate', opts: { deal_id: id, event } }); await route(i, ctx); await ctx.settle(); return text(i); };
  await route(fake(ctx, 'btn', MM, { roles: [ROLE.mm], customId: `nx:claim:${id}` }), ctx);
  const vEarly = fake(ctx, 'cmd', A, { command: 'vouch', opts: { deal_id: id, rating: 5, feedback: 'Smooth trade!' } }); await route(vEarly, ctx);
  assert.match(text(vEarly), /completed/);
  assert.match(await sim('escrow.completed'), /rejected_not_funded/); assert.equal(ctx.deals.get(id).status, 'awaiting_provider');
  await sim('funds.observed'); assert.equal(ctx.deals.get(id).status, 'verification_pending');
  await sim('escrow.funded'); assert.equal(ctx.deals.get(id).escrow_status, 'provider_confirmed');
  assert.match(await sim('escrow.completed'), /rejected_no_payout_address/); payDb(ctx, id);
  assert.match(await sim('escrow.completed'), /applied/); assert.equal(ctx.deals.get(id).status, 'completed');
  await sim('escrow.completed');
  const pub = ctx.chans.get('completed').sent; assert.equal(pub.length, 1, 'published exactly once');
  const pj = JSON.stringify(pub[0].embeds[0].data);
  assert.ok(pj.includes(id) && pj.includes('user111') && pj.includes('user222') && pj.includes('user333'));
  assert.ok(!/Dominus|DEMO-/.test(pj), 'no item description or wallet/provider data published'); assert.match(pj, /Litecoin Deal Complete/); assert.ok(pub[0].files.length === 1, 'coin thumbnail attached');
  const v = fake(ctx, 'cmd', A, { command: 'vouch', opts: { deal_id: id, rating: 5, feedback: 'Smooth trade!' } }); await route(v, ctx);
  assert.match(text(v), /Verified Vouch/); assert.equal(ctx.chans.get('vouches').sent.length, 1);
  const v2 = fake(ctx, 'cmd', A, { command: 'vouch', opts: { deal_id: id, rating: 3, feedback: 'again again' } }); await route(v2, ctx); assert.match(text(v2), /already/);
  const v3 = fake(ctx, 'cmd', RND, { command: 'vouch', opts: { deal_id: id, rating: 3, feedback: 'not mine ok' } }); await route(v3, ctx); assert.match(text(v3), /participants/);
  const cancel = fake(ctx, 'btn', A, { customId: `nx:cancel:${id}` }); await route(cancel, ctx); assert.match(text(cancel), /Funds have been observed/);
  assert.ok(verifyAuditChain(ctx.db).ok);
  const sim2 = fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'staff', sub: 'simulate', opts: { deal_id: id, event: 'escrow.funded' } }); ctx.mode = 'live'; await route(sim2, ctx); assert.match(text(sim2), /only available in demo/);
});

test('dispute: opens private staff channel, referred to provider, evidence saved; ticket + transcript', async () => {
  const ctx = setup(); const id = await runToRoom(ctx);
  const out = fake(ctx, 'btn', RND, { customId: `nx:dispute:${id}` }); await route(out, ctx); assert.match(text(out), /Only the participants/);
  const dm = fake(ctx, 'btn', A, { customId: `nx:dispute:${id}` }); await route(dm, ctx); assert.ok(dm.modal);
  const sub = fake(ctx, 'modal', A, { customId: dm.modal.data.custom_id, fields: { reason: 'Seller went silent after paying' } }); await route(sub, ctx); await ctx.settle();
  assert.match(text(sub), /external|provider/); const d = ctx.deals.get(id); assert.equal(d.status, 'disputed');
  const dc = ctx.chans.get(d.dispute_channel_id);
  assert.ok(!dc.opts.permissionOverwrites.some((o) => o.id === A || o.id === B), 'parties not in staff review channel');
  assert.ok(dc.opts.permissionOverwrites.some((o) => o.id === ROLE.sup));
  assert.match(JSON.stringify(dc.sent[0].embeds.map((e) => e.data)), /Seller went silent/);
  const ev = fake(ctx, 'cmd', B, { command: 'evidence', opts: { deal_id: id, note: 'chat log', file: { url: 'https://cdn.discordapp.com/x.png' } } }); await route(ev, ctx);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM evidence WHERE deal_id=?').get(id).n, 2);
  const evBad = fake(ctx, 'cmd', B, { command: 'evidence', opts: { deal_id: id, note: 'chat log', file: { url: 'http://evil' } } }); await route(evBad, ctx); assert.match(text(evBad), /https/);
  const t = ctx.db.prepare("SELECT id FROM tickets WHERE kind='dispute'").get().id;
  const nope = fake(ctx, 'btn', A, { customId: `nx:tclose:${t}`, channel: dc }); await route(nope, ctx); assert.match(text(nope), /cannot close/);
  const cl = fake(ctx, 'btn', SUP, { roles: [ROLE.sup], customId: `nx:tclose:${t}`, channel: dc }); await route(cl, ctx);
  assert.match(text(cl), /Transcript saved/); assert.ok(ctx.db.prepare('SELECT sha256 FROM transcripts WHERE ticket_id=?').get(t));
  assert.equal(ctx.db.prepare('SELECT status FROM tickets WHERE id=?').get(t).status, 'closed');
  assert.equal(ctx.deals.get(id).status, 'disputed', 'closing a ticket never resolves the dispute');
  assert.ok(ctx.chans.get('tr').sent.length === 1);
  // support ticket
  const tk = fake(ctx, 'modal', RND, { customId: 'nx:ticketmodal', fields: { subject: 'Need help', details: 'I need help with something' } }); await route(tk, ctx);
  assert.match(text(tk), /Ticket opened/);
  const staffCall = fake(ctx, 'btn', A, { customId: `nx:staff:${id}` }); await route(staffCall, ctx); assert.match(text(staffCall), /Staff notified/);
  const staffCall2 = fake(ctx, 'btn', A, { customId: `nx:staff:${id}` }); await route(staffCall2, ctx); assert.match(text(staffCall2), /already called/);
});

test('rate limits and unexpected errors are handled without leaking details', async () => {
  const ctx = setup(); let last;
  for (let n = 0; n < 4; n++) { last = await submit(ctx, A, 'nx:ticketmodal', { subject: 'Need help', details: 'I need help with something' }); }
  assert.match(text(last), /Slow down/);
  const g = setup(); process.env.TEST_GLOBAL_LIMIT = '1';
  for (let n = 0; n < 16; n++) { last = fake(g, 'cmd', A, { command: 'mydeals' }); await route(last, g); }
  delete process.env.TEST_GLOBAL_LIMIT; assert.match(text(last), /Slow down/);
  const ctx2 = setup(); ctx2.deals = null;
  const e = fake(ctx2, 'cmd', A, { command: 'mydeals' }); await route(e, ctx2); assert.match(text(e), /Reference `[0-9a-f]{6}`/); assert.doesNotMatch(text(e), /TypeError|Cannot read/);
});

test('webhook HTTP: signature required, replay safe, drives deal to completion', async () => {
  const ctx = setup(); const id = await runToRoom(ctx);
  const ref = ctx.deals.get(id).provider_ref;
  const srv = createServer({ cfg: ctx.cfg, db: ctx.db, deals: ctx.deals, mode: 'demo' }); await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
  const post = (body, sig, p = '/webhooks/provider') => new Promise((res) => { const rq = http.request({ port, path: p, method: 'POST', headers: sig ? { 'x-nexora-signature': sig } : {} }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ code: r.statusCode, body: b })); }); rq.end(body); });
  const evt = (t, n, x = {}) => JSON.stringify({ id: `w-${n}`, type: t, reference: ref, ...x });
  assert.equal((await post(evt('escrow.funded', 1))).code, 401);
  assert.equal((await post(evt('escrow.funded', 1), 'garbage')).code, 401);
  const b1 = evt('escrow.funded', 1); assert.equal((await post(b1, sign('wrong', b1))).code, 401);
  assert.equal((await post(b1, sign('whsec', b1, 1000))).code, 401);
  assert.equal(ctx.deals.get(id).escrow_status, 'pending', 'unsigned events change nothing');
  assert.equal((await post('{not json', sign('whsec', '{not json'))).code, 400);
  assert.equal((await post('{"id":"x"}', sign('whsec', '{"id":"x"}'))).code, 400);
  const ok = await post(b1, sign('whsec', b1)); assert.equal(ok.code, 200); assert.match(ok.body, /applied/);
  assert.match((await post(b1, sign('whsec', b1))).body, /duplicate/);
  const b2h = evt('escrow.completed', 20); assert.match((await post(b2h, sign('whsec', b2h))).body, /rejected_no_payout_address/); payDb(ctx, id);
  const b2 = evt('escrow.completed', 2); assert.match((await post(b2, sign('whsec', b2))).body, /applied/);
  await ctx.settle(); assert.equal(ctx.deals.get(id).status, 'completed'); assert.equal(ctx.chans.get('completed').sent.length, 1);
  const b3 = evt('escrow.completed', 3); assert.match((await post(b3, sign('whsec', b3))).body, /duplicate_completion/);
  await ctx.settle(); assert.equal(ctx.chans.get('completed').sent.length, 1);
  const big = 'x'.repeat(70000); assert.equal((await post(big, sign('whsec', big))).code, 413);
  assert.equal((await post('{}', null, '/nope')).code, 404);
  assert.ok(ctx.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='webhook.rejected'").get().n >= 4);
  const h = await new Promise((r) => http.get({ port, path: '/health' }, (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => r({ code: x.statusCode, b })); }));
  assert.equal(h.code, 200); srv.close();
});

test('idle setup deals are cancelled after 30 minutes; funded deals are never touched', async () => {
  const { closeIdleDeals } = await import('../src/jobs/idle.js');
  const ctx = setup(); const { d } = await startDeal(ctx); const live = await runToRoom(ctx);
  assert.equal(await closeIdleDeals(ctx, Date.now() + 29 * 60e3), 0);
  assert.equal(await closeIdleDeals(ctx, Date.now() + 31 * 60e3), 1);
  assert.equal(ctx.deals.get(d.id).status, 'cancelled'); assert.equal(ctx.deals.get(live).status, 'awaiting_provider');
  assert.ok(ctx.db.prepare('SELECT 1 FROM transcripts WHERE ticket_id=?').get(d.id));
});

test('completed deal rooms are removed 5 minutes after completion, transcript saved first', async () => {
  const { closeFinishedRooms } = await import('../src/jobs/idle.js');
  const ctx = setup(); const id = await runToRoom(ctx); const ref = ctx.deals.get(id).provider_ref;
  const ev = (type) => ctx.deals.applyProviderEvent({ id: `t-${type}`, type, reference: ref }, { simulated: true });
  ev('escrow.funded'); payDb(ctx, id); assert.equal(ev('escrow.completed').outcome, 'applied'); await ctx.settle();
  assert.equal(await closeFinishedRooms(ctx, Date.now() + 4 * 60e3), 0, 'not yet');
  assert.equal(await closeFinishedRooms(ctx, Date.now() + 6 * 60e3), 1);
  assert.ok(ctx.db.prepare('SELECT 1 FROM transcripts WHERE ticket_id=?').get(id)); assert.equal(ctx.chans.get(ctx.room).deleted, true);
  assert.equal(await closeFinishedRooms(ctx, Date.now() + 7 * 60e3), 0, 'only once');
});

test('partner step: creator types @user or an ID in the room', async () => {
  const { partnerFromMessage } = await import('../src/discord/automm.js');
  const ctx = setup(); const { d } = await startDeal(ctx); const id = d.id; const ch = ctx.chans.get(ctx.room);
  const sel = async (u, cid, extra) => { const i = fake(ctx, 'select', u, { customId: cid, channel: ch, ...extra }); await route(i, ctx); return i; };
  await sel(A, `nx:am-type:${id}`, { values: ['in-game'] });
  const replies = []; const msg = (author, content, mentioned) => ({ author: { id: author, bot: false }, guild: ctx.guild, channel: ch, channelId: ch.id, content, mentions: { users: { first: () => (mentioned ? { id: mentioned } : undefined) } },
    reply: async (o) => { replies.push(o.content); }, delete: async () => {} });
  ch.messages = { fetch: async () => ({ edit: async () => {} }) };
  await partnerFromMessage(msg(B, `${B}`), ctx); assert.equal(ctx.deals.get(id).party_b, null, 'only the creator counts');
  await partnerFromMessage(msg(A, 'hello'), ctx); assert.match(replies.at(-1), /Mention the other trader/);
  await partnerFromMessage(msg(A, `<@${A}>`, A), ctx); assert.match(replies.at(-1), /yourself/);
  await partnerFromMessage(msg(A, `<@${B}>`, B), ctx); assert.equal(ctx.deals.get(id).party_b, B);
  assert.ok(ch.perms.some(([u]) => u === B));
});
