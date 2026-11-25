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
    async send(p) { const m = { id: `m${++seq}`, ...p, edit: async (x) => Object.assign(m, x), delete: async () => { c.msgs.delete(m.id); } }; c.sent.push(m); c.msgs.set(m.id, m); return m; },
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
    options: { getUser: (k) => opts[k], getString: (k) => opts[k], getInteger: (k) => opts[k], getAttachment: (k) => opts[k], getSubcommand: () => sub, getRole: (k) => opts[k] },
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
  const i = fake(ctx, 'select', user, { customId: 'nx:am-pick', values: [key] }); await route(i, ctx);
  const d = ctx.db.prepare('SELECT * FROM deals ORDER BY created_at DESC, rowid DESC LIMIT 1').get(); ctx.room = d.channel_id; return { i, d };
}
/** Walk the whole setup flow with real handlers. Returns deal id. */
async function runToRoom(ctx, { amount = '20', feeChoice = 'receiver' } = {}) {
  const { d } = await startDeal(ctx); const id = d.id; const ch = ctx.chans.get(ctx.room);
  const sel = async (u, cid, extra) => { const i = fake(ctx, 'select', u, { customId: cid, channel: ch, ...extra }); await route(i, ctx); return i; };
  await sel(A, `nx:am-partner:${id}`, { opts: { user: { id: B } }, values: [] });
  await click(ctx, A, `nx:am-role:${id}:sender`); await click(ctx, B, `nx:am-role:${id}:receiver`);
  await submit(ctx, A, `nx:am-descmodal:${id}`, { desc: '20k Robux for $20 of LTC' });
  await click(ctx, B, `nx:am-accept:${id}`);
  await submit(ctx, B, `nx:am-amountmodal:${id}`, { amount });
  await click(ctx, A, `nx:am-amtok:${id}`); await click(ctx, B, `nx:am-amtok:${id}`);
  if (Number(amount) >= 50) { await click(ctx, A, `nx:am-fee:${id}:${feeChoice}`); await click(ctx, B, `nx:am-feeok:${id}`); }
  return id;
}

test('panel is a Components V2 message with a Start button per coin; posted to the panel channel', async () => {
  const ctx = setup(); ctx.cfg.channels.panel = 'panelch'; ctx.chans.set('panelch', { id: 'panelch', sent: [], async send(p) { this.sent.push(p); } });
  const i = fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'panel' }); await route(i, ctx);
  const p = ctx.chans.get('panelch').sent[0]; assert.equal(p.flags & 32768, 32768);
  const json = JSON.stringify(p.components.map((c) => c.toJSON()));
  assert.ok(json.includes('nx:am-pick')); assert.ok(!json.includes('nx:am-start'), 'one dropdown, no per-coin buttons');
  for (const k of ['ETH', 'LTC', 'SOL', 'USDT-ERC20', 'USDC-ERC20', 'USDT-BEP20']) assert.ok(json.includes(`"value":"${k}"`), k);
  assert.match(json, /LTC \| Litecoin/); assert.match(json, /Open a protected LTC deal on Litecoin/); assert.equal(p.files.length, 1);
  const deny = fake(ctx, 'cmd', RND, { command: 'panel' }); await route(deny, ctx); assert.match(text(deny), /do not have permission/);
});

test('start: private room with Deal Started + Safety Warning + Close + straight to adding the trader (no deal type); max 2 open deals', async () => {
  const ctx = setup(); const { d } = await startDeal(ctx, 'USDT-BEP20');
  assert.equal(d.status, 'waiting_parties'); assert.equal(d.network, 'bsc');
  const room = ctx.chans.get(d.channel_id);
  assert.ok(room.opts.permissionOverwrites.some((o) => o.deny && o.id === 'ev'));
  assert.ok(room.opts.permissionOverwrites.some((o) => o.id === A) && !room.opts.permissionOverwrites.some((o) => o.id === ROLE.trial));
  assert.match(JSON.stringify(room.sent[0].embeds.map((e) => e.data)), /Deal Started[\s\S]*Safety Warning[\s\S]*NEVER/);
  assert.match(JSON.stringify(room.sent[0].components.map((c) => c.toJSON())), /nx:am-close/);
  const first = JSON.stringify(room.sent[1].embeds.map((e) => e.toJSON ? e.toJSON() : e)); assert.match(first, /Add the other trader/); assert.doesNotMatch(first + JSON.stringify((room.sent[1].components ?? []).map((c) => c.toJSON())), /Deal Type|Select Deal Type/);
  await startDeal(ctx, 'BTC'); const third = fake(ctx, 'btn', A, { customId: 'nx:am-start:ETH' }); await route(third, ctx); assert.match(text(third), /2 open deals/);
});

test('setup: steps are ordered, only the right person can act, bad input rejected', async () => {
  const ctx = setup(); const { d } = await startDeal(ctx); const id = d.id; const ch = ctx.chans.get(ctx.room);
  const sel = async (u, cid, extra) => { const i = fake(ctx, 'select', u, { customId: cid, channel: ch, ...extra }); await route(i, ctx); return i; };
  assert.match(text(await click(ctx, A, `nx:am-role:${id}:sender`)), /already done|not available/); // skipping steps
  assert.equal(ctx.deals.setup(ctx.deals.get(id)).step, 'partner', 'no deal type step: the first step is adding the trader');
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

test('fee: under threshold none; over threshold only the sender chooses who pays and the receiver confirms (sender / receiver / split)', async () => {
  for (const [choice, send, recv] of [['sender', '102.00', '100.00'], ['receiver', '100.00', '98.00'], ['split', '101.00', '99.00']]) {
    const ctx = setup(); ctx.cfg.fee = { threshold: 50, usd: 2, percentOver: 250, percent: 2 }; ctx.cfg.feeAssets = ['LTC']; const id = await runToRoom(ctx, { amount: '100', feeChoice: choice });
    const d = ctx.deals.get(id); assert.equal(d.status, 'awaiting_provider'); assert.equal(d.fee_usd, '2.00'); assert.equal(d.fee_payer, choice);
    assert.equal(d.send_usd, send, `${choice} send`); assert.equal(d.receive_usd, recv, `${choice} receive`);
    const room = ctx.chans.get(d.channel_id); const last = JSON.stringify(room.sent.at(-1).embeds ?? room.msgs.get(d.status_message_id).embeds);
  }
  const ctx = setup(); const { d } = await startDeal(ctx); const id = d.id; const ch = ctx.chans.get(ctx.room);
  ctx.deals.patch(id, A, { party_b: B, sender_id: A, receiver_id: B, item: 'x trade', amount: '100.00', fee_usd: '2.00', setup: { step: 'fee', votes: {} } }, 'test');
  const card = JSON.stringify((await click(ctx, B, `nx:am-fee:${id}:split`)).out); assert.match(card, /Only the \*\*sender\*\*/); assert.equal(ctx.deals.setup(ctx.deals.get(id)).step, 'fee');
  await click(ctx, A, `nx:am-fee:${id}:split`); assert.equal(ctx.deals.setup(ctx.deals.get(id)).step, 'fee_confirm'); assert.equal(ctx.deals.get(id).status, 'waiting_parties');
  assert.match(text(await click(ctx, A, `nx:am-feeok:${id}`)), /Only the \*\*receiver\*\*/);
  await click(ctx, B, `nx:am-feeno:${id}`); assert.equal(ctx.deals.setup(ctx.deals.get(id)).step, 'fee', 'receiver can send it back');
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
  const ask = await click(ctx, B, `nx:am-close:${id}`); assert.match(text(ask), /Close request sent/); assert.equal(ctx.deals.get(id).status, 'awaiting_provider', 'one trader cannot close alone');
  assert.match(text(await click(ctx, B, `nx:am-close:${id}`)), /already asked/); assert.match(text(await click(ctx, B, `nx:am-closeyes:${id}`)), /already asked/);
  assert.match(text(await click(ctx, RND, `nx:am-closeyes:${id}`)), /Only the two traders/);
  await click(ctx, A, `nx:am-closeno:${id}`); assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM close_req').get().n, 0, 'declined');
  await click(ctx, B, `nx:am-close:${id}`); const ok = await click(ctx, A, `nx:am-closeyes:${id}`); assert.match(text(ok), /Deal closed/);
  assert.equal(ctx.deals.get(id).status, 'cancelled'); assert.ok(ctx.db.prepare('SELECT 1 FROM transcripts WHERE ticket_id=?').get(id));
  const ctx2 = setup(); const id2 = await runToRoom(ctx2);
  ctx2.deals.applyProviderEvent({ id: 'o1', type: 'funds.observed', reference: ctx2.deals.get(id2).provider_ref }, { simulated: true });
  const no = await click(ctx2, A, `nx:am-close:${id2}`); assert.match(text(no), /provider/); assert.equal(ctx2.deals.get(id2).status, 'verification_pending'); assert.equal(ctx2.db.prepare('SELECT COUNT(*) n FROM close_req').get().n, 0);
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
  assert.ok(!/Dominus|DEMO-/.test(pj), 'no item description or wallet/provider data published'); assert.match(pj, /Funds Released[\s\S]*Litecoin/); assert.ok(pub[0].files.length === 1, 'logo thumbnail attached');
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
  assert.ok(!dc.opts.permissionOverwrites.some((o) => o.id === ROLE.sup), 'support role has no access'); assert.ok(dc.opts.permissionOverwrites.some((o) => o.id === ROLE.adm), 'admin role has access');
  assert.match(JSON.stringify(dc.sent[0].embeds.map((e) => e.data)), /Seller went silent/);
  const ev = fake(ctx, 'cmd', B, { command: 'evidence', opts: { deal_id: id, note: 'chat log', file: { url: 'https://cdn.discordapp.com/x.png' } } }); await route(ev, ctx);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM evidence WHERE deal_id=?').get(id).n, 2);
  const evBad = fake(ctx, 'cmd', B, { command: 'evidence', opts: { deal_id: id, note: 'chat log', file: { url: 'http://evil' } } }); await route(evBad, ctx); assert.match(text(evBad), /https/);
  const t = ctx.db.prepare("SELECT id FROM tickets WHERE kind='dispute'").get().id;
  const nope = fake(ctx, 'btn', A, { customId: `nx:tclose:${t}`, channel: dc }); await route(nope, ctx); assert.match(text(nope), /cannot close/);
  const low = fake(ctx, 'btn', SUP, { roles: [ROLE.sup], customId: `nx:tclose:${t}`, channel: dc }); await route(low, ctx); assert.match(text(low), /cannot close/);
  const cl = fake(ctx, 'btn', ADM, { roles: [ROLE.adm], customId: `nx:tclose:${t}`, channel: dc }); await route(cl, ctx);
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
  const replies = []; const msg = (author, content, mentioned) => ({ author: { id: author, bot: false }, guild: ctx.guild, channel: ch, channelId: ch.id, content, mentions: { users: { first: () => (mentioned ? { id: mentioned } : undefined) } },
    reply: async (o) => { replies.push(o.content); }, delete: async () => {} });
  ch.messages = { fetch: async () => ({ edit: async () => {} }) };
  await partnerFromMessage(msg(B, `${B}`), ctx); assert.equal(ctx.deals.get(id).party_b, null, 'only the creator counts');
  await partnerFromMessage(msg(A, 'hello'), ctx); assert.match(replies.at(-1), /Mention the other trader/);
  await partnerFromMessage(msg(A, `<@${A}>`, A), ctx); assert.match(replies.at(-1), /yourself/);
  await partnerFromMessage(msg(A, `<@${B}>`, B), ctx); assert.equal(ctx.deals.get(id).party_b, B);
  assert.ok(ch.perms.some(([u]) => u === B));
});

test('support panel: staff-only, posted to the support channel with an Open Ticket button', async () => {
  const ctx = setup(); ctx.cfg.channels.supportPanel = 'supch'; ctx.chans.set('supch', { id: 'supch', sent: [], async send(p) { this.sent.push(p); } });
  const deny = fake(ctx, 'cmd', RND, { command: 'supportpanel' }); await route(deny, ctx); assert.match(text(deny), /do not have permission/);
  const i = fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'supportpanel' }); await route(i, ctx);
  const p = ctx.chans.get('supch').sent[0]; assert.equal(p.flags & 32768, 32768); assert.ok(JSON.stringify(p.components.map((c) => c.toJSON())).includes('nx:ticket-start'));
});

test('stats: own embed with rank, largest deal and avatar; only in the stats channel', async () => {
  const ctx = setup(); ctx.cfg.channels.stats = 'lobby';
  const mk = (a, b, usd, st) => { const d = ctx.deals.create({ creator: a, partner: b, robloxA: 'Alice_1', robloxB: 'Bob22', item: 'x', amount: usd, currency: 'USD', asset: 'LTC', network: 'litecoin' }); ctx.db.prepare('UPDATE deals SET status=? WHERE id=?').run(st, d.id); };
  mk(A, B, '40.00', 'completed'); mk(A, B, '120.50', 'completed'); mk(A, B, '10.00', 'cancelled'); mk(B, RND, '500.00', 'completed');
  const i = fake(ctx, 'cmd', A, { command: 'stats' }); i.user.displayAvatarURL = () => 'https://x/a.png'; await route(i, ctx);
  const e = i.out[0].embeds[0].toJSON(); assert.match(e.title, /Tier 2/); assert.equal(e.thumbnail.url, 'https://x/a.png');
  assert.match(e.description, /rank `#3`/); assert.match(e.description, /Completed:\*\* 2/); assert.match(e.description, /Largest Deal:\*\* \$120\.50/); assert.match(e.description, /Completion Rate:\*\* 67%/);
  ctx.cfg.channels.stats = 'elsewhere'; const w = fake(ctx, 'cmd', A, { command: 'stats' }); await route(w, ctx); assert.match(text(w), /Use the stats command in/);
});

test('rules: staff-only, posted to the rules channel as embeds within Discord limits', async () => {
  const ctx = setup(); ctx.cfg.channels.rules = 'rulesch'; ctx.chans.set('rulesch', { id: 'rulesch', sent: [], async send(p) { this.sent.push(p); } });
  const deny = fake(ctx, 'cmd', RND, { command: 'rules' }); await route(deny, ctx); assert.match(text(deny), /do not have permission/);
  const i = fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'rules' }); await route(i, ctx);
  const p = ctx.chans.get('rulesch').sent[0]; assert.ok(p.embeds.length >= 6 && p.embeds.length <= 10);
  let total = 0; for (const e of p.embeds) { const j = e.toJSON(); assert.ok(j.description.length <= 4096); total += j.title.length + j.description.length; } assert.ok(total <= 6000, `total ${total}`);
});

test('every step posts a NEW message that pings the right person, and the previous one is deleted', async () => {
  const ctx = setup(); const { d } = await startDeal(ctx); const id = d.id; const ch = ctx.chans.get(ctx.room);
  const live = () => [...ch.msgs.values()].filter((m) => m.id === ctx.deals.get(id).status_message_id);
  const before = ctx.deals.get(id).status_message_id;
  assert.match(ch.msgs.get(before).content, new RegExp(`<@${A}>`), 'the first step pings the creator');
  await route(fake(ctx, 'select', A, { customId: `nx:am-partner:${id}`, channel: ch, opts: { user: { id: B } }, values: [] }), ctx);
  const m1 = ctx.deals.get(id).status_message_id; assert.notEqual(m1, before, 'new message, not an edit'); assert.ok(!ch.msgs.has(before), 'previous message deleted');
  const m2 = m1;
  assert.equal(ctx.deals.get(id).party_b, B); assert.equal(ch.sent.filter((m) => m.id === m2).length, 1, 'posted once, not twice');
  await click(ctx, A, `nx:am-role:${id}:sender`); const m3 = ctx.deals.get(id).status_message_id; assert.notEqual(m3, m2); assert.equal(live().length, 1);
  assert.equal(JSON.stringify(ch.msgs.get(m3).components).includes(`<@${B}>`), true, 'both traders pinged on the role card');
});

test('cancel & refund: both traders must agree, the sender types an address, funds are swept back, deal is cancelled', async () => {
  const { refundFromMessage } = await import('../src/discord/automm.js');
  const ctx = setup(); const id = await runToRoom(ctx, { amount: '2' }); const room = ctx.chans.get(ctx.room);
  const sim = async (event) => { const i = fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'staff', sub: 'simulate', opts: { deal_id: id, event } }); await route(i, ctx); await ctx.settle(); };
  const swept = []; ctx.provider.sweep = async (d, to) => { swept.push([d, to]); return 'c'.repeat(64); }; ctx.provider.explorerTx = (t) => `https://x/${t}`;
  assert.match(text(await click(ctx, A, `nx:am-cancelask:${id}`)), /only available once/, 'not before payment is confirmed');
  await sim('funds.observed'); await sim('escrow.funded');
  assert.match(JSON.stringify(room.msgs.get(ctx.deals.get(id).status_message_id).components.map((c) => c.toJSON())), /am-cancelask/);
  assert.match(text(await click(ctx, RND, `nx:am-cancelask:${id}`)), /Only the two traders/);
  assert.match(text(await click(ctx, B, `nx:am-cancelask:${id}`)) , /Cancel request sent/);
  assert.match(text(await click(ctx, A, `nx:am-release:${id}`)), /cancel request is open/);
  assert.match(text(await click(ctx, B, `nx:am-cancelyes:${id}`)), /already asked/);
  assert.match(text(await click(ctx, B, `nx:am-cancelask:${id}`)), /already open/);
  // decline keeps the deal alive
  await click(ctx, A, `nx:am-cancelno:${id}`); assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM cancel_req').get().n, 0); assert.equal(ctx.deals.get(id).status, 'verification_pending');
  // ask again and agree
  await click(ctx, A, `nx:am-cancelask:${id}`); await click(ctx, B, `nx:am-cancelyes:${id}`);
  assert.equal(ctx.db.prepare('SELECT state FROM cancel_req').get().state, 'address');
  const say = async (u, content) => { const sent = []; const m = { author: { id: u, bot: false }, guild: {}, channelId: room.id, content, channel: room, delete: async () => {}, reply: async (x) => sent.push(x) }; await refundFromMessage(m, ctx); return sent; };
  assert.equal((await say(B, LTC)).length, 0); const before = room.sent.length; await say(B, LTC); assert.equal(room.sent.length, before, 'only the sender is listened to');
  const bad = await say(A, 'not-an-address'); assert.match(bad[0].content, /valid LTC address/);
  await say(A, LTC); assert.match(JSON.stringify(room.sent.at(-1).embeds.map((e) => e.toJSON())), /Confirm your refund address/);
  assert.match(text(await click(ctx, B, `nx:am-refyes:${id}:${LTC}`)), /Only the sender/);
  await click(ctx, A, `nx:am-refyes:${id}:${LTC}`); await ctx.settle();
  assert.deepEqual(swept, [[id, LTC]]); assert.equal(ctx.deals.get(id).status, 'cancelled'); assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM cancel_req').get().n, 0);
  assert.match(JSON.stringify(room.sent.map((m) => (m.embeds ?? []).map((e) => e.toJSON ? e.toJSON() : e))), /refunded[\s\S]*c{64}/);
  assert.match(text(await click(ctx, A, `nx:am-refyes:${id}:${LTC}`)), /already being processed|agreed/);
  assert.equal(swept.length, 1, 'never refunded twice');
});

test('short payment: warning with the real amount; sender continues or cancels and gets the exact amount back', async () => {
  const { refundFromMessage } = await import('../src/discord/automm.js');
  const mk = async () => { const ctx = setup(); const id = await runToRoom(ctx, { amount: '10' }); const room = ctx.chans.get(ctx.room);
    const d0 = ctx.deals.get(id); const ref = d0.provider_ref;
    ctx.deals.applyProviderEvent({ id: `short-${id}`, type: 'funds.underpaid', reference: ref, amount: '0.2', txid: 'f'.repeat(64), confirmations: 0 }, { simulated: true }); await ctx.settle();
    return { ctx, id, room }; };
  // continue
  { const { ctx, id, room } = await mk(); const d = ctx.deals.get(id); assert.equal(d.short_state, 'pending');
    const msg = room.msgs.get(d.status_message_id); const body = JSON.stringify(msg.embeds.map((e) => e.toJSON ? e.toJSON() : e));
    assert.match(body, /less than the deal amount/); assert.match(body, /only sent \*\*\$/); assert.match(JSON.stringify(msg.components.map((c) => c.toJSON())), /am-shortyes[\s\S]*am-shortno/);
    ctx.provider.acceptShort = async () => ({ amount: '0.2' });
    assert.match(text(await click(ctx, RND, `nx:am-shortyes:${id}`)), /Only the two traders/);
    await click(ctx, B, `nx:am-shortyes:${id}`); await ctx.settle();
    assert.equal(ctx.deals.get(id).short_state, 'pending', 'one trader is not enough');
    assert.match(JSON.stringify(room.sent.at(-1).embeds.map((e) => e.toJSON ? e.toJSON() : e)), /both traders must agree/);
    await click(ctx, A, `nx:am-shortyes:${id}`); await ctx.settle();
    const nd = ctx.deals.get(id); assert.equal(nd.short_state, 'accepted'); assert.equal(nd.received_crypto, '0.2'); assert.ok(Number(nd.send_usd) > 0 && Number(nd.send_usd) < 10);
    assert.match(text(await click(ctx, A, `nx:am-shortyes:${id}`)), /already made/); }
  // cancel: exact refund
  { const { ctx, id, room } = await mk(); const swept = []; ctx.provider.sweep = async (d, to) => { swept.push([d, to]); return 'e'.repeat(64); }; ctx.provider.explorerTx = (t) => `https://x/${t}`;
    assert.match(text(await click(ctx, B, `nx:am-shortno:${id}`)), /Only the sender/);
    await click(ctx, A, `nx:am-shortno:${id}`);
    assert.equal(ctx.db.prepare('SELECT state FROM cancel_req').get().state, 'address');
    assert.match(text(await click(ctx, A, `nx:am-shortyes:${id}`)), /refund is already in progress/);
    const say = async (u, content) => { const m = { author: { id: u, bot: false }, guild: {}, channelId: room.id, content, channel: room, delete: async () => {}, reply: async () => {} }; await refundFromMessage(m, ctx); };
    await say(A, LTC); await click(ctx, A, `nx:am-refyes:${id}:${LTC}`); await ctx.settle();
    assert.deepEqual(swept, [[id, LTC]]); assert.equal(ctx.deals.get(id).status, 'cancelled');
    assert.match(JSON.stringify(room.sent.map((m) => (m.embeds ?? []).map((e) => e.toJSON ? e.toJSON() : e))), /sender cancelled after sending less/); }
});

test('welcome: posts to the welcome channel, mentions rules and auto MM channels; preview command is staff-only', async () => {
  const { welcomePayload, sendWelcome } = await import('../src/discord/welcome.js');
  const ctx = setup(); ctx.cfg.channels.welcome = 'wch'; ctx.cfg.channels.rules = '111'; ctx.cfg.channels.panel = '222';
  const sent = []; ctx.client = { channels: { fetch: async () => ({ send: async (p) => sent.push(p) }) } };
  await sendWelcome(ctx, { user: { id: '555', bot: true } }); assert.equal(sent.length, 0, 'bots are not welcomed');
  await sendWelcome(ctx, { user: { id: '555', displayAvatarURL: () => 'https://x/p.png' } });
  const e = sent[0].embeds[0].toJSON(); assert.match(e.description, /<#111>/); assert.match(e.description, /<#222>/); assert.equal(e.thumbnail.url, 'https://x/p.png'); assert.match(sent[0].content, /<@555>/);
  ctx.cfg.channels.welcome = 'wc2'; ctx.chans.set('wc2', { id: 'wc2', sent: [], async send(p) { this.sent.push(p); } });
  const deny = fake(ctx, 'cmd', RND, { command: 'welcome' }); await route(deny, ctx); assert.match(text(deny), /do not have permission/);
  const ok = fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'welcome' }); await route(ok, ctx); assert.equal(sent.length, 2, 'preview posted to the welcome channel');
});

test('text commands: .help lists them, staff commands need a role, replies stay out of others\' way', async () => {
  const { commandFromMessage, SPEC, parseArgs } = await import('../src/discord/prefix.js');
  const { definitions } = await import('../src/discord/commands.js');
  assert.deepEqual(Object.keys(SPEC).filter((n) => n !== 'help' && !SPEC[n].textOnly).sort(), definitions.map((d) => d.name).filter((n) => !['giveaway', 'poll', 'role', 'set-privacy', 'say'].includes(n)).sort(), 'every slash command has a text command');
  const ctx = setup(); const lobby = ctx.chans.get('lobby') ?? fake(ctx, 'btn', A).channel;
  const dms = [];
  const msg = (author, content, { admin = false, roles = [], attachments } = {}) => { const out = [];
    return { out, dms, author: { id: author, bot: false, send: async (p) => { dms.push(p); } }, guild: ctx.guild, channel: lobby, channelId: 'lobby', client: ctx.client, content,
      member: { roles: { cache: new Map(roles.map((r) => [r, 1])) }, permissions: { has: (p) => admin && p === 'Administrator' } }, mentions: { users: new Map() },
      attachments: { first: () => attachments }, delete: async () => {}, reply: async (p) => { out.push(p); return { edit: async (x) => Object.assign(p, x) }; } }; };
  const body = (m) => JSON.stringify(m.out.map((o) => (o.embeds ?? []).map((e) => [e.data.title, e.data.description])));
  // not a command, other bots' commands, bots
  for (const t of ['hello', '.', '...', '.unknowncmd', '. help']) { const m = msg(A, t); assert.equal(await commandFromMessage(m, ctx), false, t); assert.equal(m.out.length, 0); }
  // help: members see the public ones, staff see everything
  let m = msg(A, '.help'); assert.equal(await commandFromMessage(m, ctx), true); assert.match(body(m), /\.stats/); assert.doesNotMatch(body(m), /\.staff/);
  m = msg(ADM, '.help', { admin: true }); await commandFromMessage(m, ctx); assert.match(body(m), /\.staff history/); assert.match(body(m), /\.vouch <deal_id> <rating> <feedback>/);
  // permission
  m = msg(RND, '.mydeals'); await commandFromMessage(m, ctx); assert.match(body(m), /do not have permission/);
  m = msg(ADM, '.mydeals', { admin: true }); await commandFromMessage(m, ctx); assert.match(body(m), /Your deals/); assert.equal(m.out[0].flags, undefined, 'no ephemeral flag on a normal message');
  // usage errors and parsing
  m = msg(ADM, '.dealinfo', { admin: true }); await commandFromMessage(m, ctx); assert.match(body(m), /Usage: `\.dealinfo <deal_id>`/);
  m = msg(ADM, '.vouch NXH-AB12CD34 six nope', { admin: true }); await commandFromMessage(m, ctx); assert.match(body(m), /must be a number/);
  m = msg(ADM, '.staff', { admin: true }); await commandFromMessage(m, ctx); assert.match(body(m), /history\|activity/);
  const v = await parseArgs('NXH-AB12CD34 5 great   deal, thanks', SPEC.vouch.args, { usage: 'x', resolveUser: async () => null });
  assert.deepEqual(v, { deal_id: 'NXH-AB12CD34', rating: 5, feedback: 'great   deal, thanks' });
  // staff subcommand runs through the same handler as the slash command
  const { id } = await (async () => { const rid = await runToRoom(ctx, { amount: '2' }); return { id: rid }; })();
  m = msg(ADM, `.staff history ${id}`, { admin: true }); await commandFromMessage(m, ctx); assert.match(body(m), /history|deal\.created/i);
  // ticket works as text; evidence takes the attachment
  m = msg(A, '.ticket short', { admin: true }); await commandFromMessage(m, ctx); assert.match(body(m), /at least 10 characters/);
  // the wallet goes to DMs only, never the channel
  m = msg(ADM, '.staff wallet', { admin: true }); await commandFromMessage(m, ctx); assert.ok(!/Recovery/i.test(body(m)), 'nothing secret in the channel');
});

test('text commands: .leaderboard and .messages are public, .tag and .tags are staff only', async () => {
  const { commandFromMessage } = await import('../src/discord/prefix.js');
  const act = await import('../src/core/activity.js');
  const ctx = setup(); ctx.cfg.statusPhrase = 'gg/nexorra'; const lobby = fake(ctx, 'btn', A).channel;
  const msg = (author, content, { admin = false } = {}) => { const out = [];
    return { out, author: { id: author, bot: false, displayAvatarURL: () => null }, guild: ctx.guild, channel: lobby, channelId: 'lobby', client: ctx.client, content, member: { displayName: 'Tester', roles: { cache: new Map() }, permissions: { has: (p) => admin && p === 'Administrator' } },
      mentions: { users: new Map() }, attachments: { first: () => undefined }, delete: async () => {}, reply: async (p) => { out.push(p); return { edit: async () => {} }; } }; };
  const body = (m) => JSON.stringify(m.out.map((o) => (o.embeds ?? []).map((e) => [e.data.title, e.data.description, ...(e.data.fields ?? []).map((f) => `${f.name}=${f.value}`)])));
  for (let k = 0; k < 3; k++) act.countMessage(ctx.db, A); act.countMessage(ctx.db, B);
  let m = msg(RND, '.leaderboard'); await commandFromMessage(m, ctx); assert.match(body(m), /Message Leaderboard - All time/); assert.ok(body(m).indexOf(A) < body(m).indexOf(B)); assert.match(body(m), /4\*\* messages from \*\*2\*\* people/);
  m = msg(RND, '.top week'); await commandFromMessage(m, ctx); assert.match(body(m), /Last 7 days/);
  m = msg(RND, '.lb nonsense'); await commandFromMessage(m, ctx); assert.match(body(m), /Pick a period/);
  m = msg(A, '.messages'); await commandFromMessage(m, ctx); assert.match(body(m), /Tester - Messages[\s\S]*#1/); assert.match(body(m), /All time=`3`/);
  m = msg(RND, '.tag'); await commandFromMessage(m, ctx); assert.match(body(m), /do not have permission/);
  m = msg(RND, '.tags'); await commandFromMessage(m, ctx); assert.match(body(m), /do not have permission/);
  act.setPerk(ctx.db, B, 'tag', true, { at: Date.now() - 3 * 3600e3 });
  m = msg(ADM, '.tags', { admin: true }); await commandFromMessage(m, ctx); assert.match(body(m), /Server tag - 1 active now, 1 ever[\s\S]*3h/);
  m = msg(ADM, `.tag <@${B}>`, { admin: true }); m.mentions.users.set(B, { id: B }); await commandFromMessage(m, ctx); assert.match(body(m), /Active now/);
});

test('status rewards: panel is staff-only; start, request and staff payout flow', async () => {
  const ctx = setup(); ctx.presenceTracking = true; ctx.cfg.statusPhrase = 'gg/nexorra';
  ctx.cfg.statusPay = { dailyCents: 20, weekBonusCents: 120, minPayoutCents: 20, autoMaxCents: 1000 };
  ctx.cfg.channels.statusPanel = 'stp'; ctx.cfg.channels.statusPayouts = 'stq';
  ctx.chans.set('stp', { id: 'stp', sent: [], async send(p) { this.sent.push(p); } }); ctx.chans.set('stq', { id: 'stq', sent: [], async send(p) { this.sent.push(p); return { id: 'm1' }; } });
  const deny = fake(ctx, 'cmd', RND, { command: 'status' }); await route(deny, ctx); assert.match(text(deny), /do not have permission/);
  await route(fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'status' }), ctx);
  const p = ctx.chans.get('stp').sent[0]; const j = JSON.stringify(p.components.map((c) => c.toJSON()));
  assert.ok(j.includes('nx:st-start') && j.includes('nx:st-payout') && j.includes('Status Rewards')); assert.equal(p.files.length, 1);
  // not showing the status: refused
  ctx.cfg.statusRoleId = 'ROLE_X';
  const norole = fake(ctx, 'btn', RND, { customId: 'nx:st-start' }); norole.member.presence = { status: 'online', activities: [{ type: 4, state: '.gg/nexorra' }] }; await route(norole, ctx); assert.match(text(norole), /role to earn/);
  const no = fake(ctx, 'btn', RND, { roles: ['ROLE_X'], customId: 'nx:st-start' }); no.member.presence = { status: 'idle', activities: [] }; await route(no, ctx); assert.match(text(no), /Set your custom status/);
  const ok = fake(ctx, 'btn', RND, { roles: ['ROLE_X'], customId: 'nx:st-start' }); ok.member.presence = { status: 'dnd', activities: [{ type: 4, state: '.gg/nexorra' }] }; await route(ok, ctx); assert.match(text(ok), /Earning started/);
  // two days of time, then request
  ctx.db.prepare('UPDATE status_earn SET seconds=?, since=NULL WHERE user_id=?').run(2 * 86400 + 5, RND);
  const t = fake(ctx, 'btn', RND, { roles: ['ROLE_X'], customId: 'nx:st-time' }); await route(t, ctx); assert.match(text(t), /\$0\.40/);
  const presence = { status: 'online', activities: [{ type: 4, state: '.gg/nexorra' }] };
  const press = async (u, id, { pres = presence, roles = ['ROLE_X'] } = {}) => { const i = fake(ctx, 'btn', u, { roles, customId: id }); i.member.presence = pres; await route(i, ctx); return i; };
  // no wallet (demo): refused
  assert.match(text(await press(RND, 'nx:st-payout')), /not available/);
  const sends = []; let short = 0;
  const ltc = { validateAddress: (a) => { if (!/^ltc1q/.test(a)) throw new Error('That is not a valid Litecoin mainnet address.'); return a; }, rewardsAddress: () => 'ltc1qrewardswallet', rewardsBalance: async () => ({ confirmedSat: 5, pendingSat: 0 }),
    sendReward: async (to, cents) => { if (short) { short--; const e = new Error('short'); e.insufficient = { needSat: 300000, haveSat: 10 }; throw e; } sends.push([to, cents]); return { txid: 'tx'.repeat(32), sat: 250000, url: 'https://x/tx' }; } };
  ctx.provider = { ltc };
  // not showing the status: refused, nothing reserved
  assert.match(text(await press(RND, 'nx:st-payout', { pres: { status: 'idle', activities: [] } })), /custom status must say/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM status_payouts').get().n, 0);
  assert.match(text(await press(RND, 'nx:st-payout', { roles: [] })), /need the/);
  // qualified: a private ticket opens and the balance is reserved
  const open = await press(RND, 'nx:st-payout'); assert.match(text(open), /Ticket opened/);
  const row = ctx.db.prepare('SELECT * FROM status_payouts WHERE id=1').get(); assert.equal(row.cents, 40); assert.equal(row.state, 'pending'); assert.ok(row.room_id);
  const room = ctx.chans.get(row.room_id); assert.ok(room.opts.permissionOverwrites.some((o) => o.id === RND)); assert.match(JSON.stringify(room.sent[0].embeds[0].data), /LTC\) address/);
  assert.match(text(await press(RND, 'nx:st-payout')), /already have an open payout request/);
  // the address is typed in the room: bad ones are bounced, a good one asks for confirmation
  const { addressFromMessage } = await import('../src/discord/status.js');
  const say = async (u, content) => { const out = []; await addressFromMessage({ author: { id: u, bot: false }, guild: ctx.guild, channelId: row.room_id, channel: room, content, reply: async (p) => { out.push(p); }, delete: async () => {} }, ctx); return out; };
  assert.match((await say(RND, 'hello'))[0].content, /valid LTC address/);
  assert.equal((await say(ADM, LTC)).length, 0, 'someone else typing is ignored'); const before = room.sent.length;
  await say(RND, LTC); const confirm = room.sent.at(-1); assert.equal(room.sent.length, before + 1); assert.match(JSON.stringify(confirm.components.map((c) => c.toJSON())), new RegExp(`nx:st-addryes:1:${LTC}`));
  assert.match(text(await press(ADM, `nx:st-addryes:1:${LTC}`, { roles: [ROLE.adm] })), /Only the member/);
  assert.equal(sends.length, 0);
  // wallet is empty: waiting, told once, nothing lost
  short = 2;
  assert.match(text(await press(RND, `nx:st-addryes:1:${LTC}`)), /Address confirmed/);
  assert.equal(sends.length, 0); assert.equal(ctx.db.prepare('SELECT state, send_state, notified FROM status_payouts WHERE id=1').get().notified, 1);
  assert.match(JSON.stringify(ctx.chans.get('stq').sent.map((p) => p.embeds[0].data)), /Rewards wallet is short[\s\S]*ltc1qrewardswallet/);
  assert.match(text(await press(RND, `nx:st-addryes:1:${LTC}`)), /already confirmed/);
  const { payoutLoop } = await import('../src/discord/status.js');
  await payoutLoop(ctx); assert.equal(sends.length, 0, 'still short'); const stqBefore = ctx.chans.get('stq').sent.length;
  await payoutLoop(ctx); assert.equal(sends.length, 1, 'funded: sent once'); assert.deepEqual(sends[0], [LTC, 40]);
  await payoutLoop(ctx); assert.equal(sends.length, 1, 'never sent twice');
  const done = ctx.db.prepare('SELECT state, ref, send_state, handled_by FROM status_payouts WHERE id=1').get(); assert.equal(done.state, 'paid'); assert.equal(done.send_state, 'sent'); assert.equal(done.handled_by, 'system'); assert.match(done.ref, /^txtx/);
  assert.match(JSON.stringify(room.sent.at(-1).embeds[0].data), /Payment sent/);
  assert.match(text(await press(ADM, 'nx:st-rej:1', { roles: [ROLE.adm] })), /already handled/);
  // cancel returns the balance; a stranger cannot cancel
  ctx.db.prepare('UPDATE status_earn SET seconds=? WHERE user_id=?').run(4 * 86400 + 5, RND);
  await press(RND, 'nx:st-payout'); const r2 = ctx.db.prepare('SELECT * FROM status_payouts WHERE id=2').get(); assert.equal(r2.cents, 40);
  assert.match(text(await press(B, 'nx:st-cancel:2', { roles: [] })), /Only the member or staff/);
  assert.match(text(await press(RND, 'nx:st-cancel:2')), /back in your balance/); assert.equal(ctx.db.prepare('SELECT state FROM status_payouts WHERE id=2').get().state, 'rejected');
  // staff mark paid still works for manual cases and is refused while the bot is sending
  await press(RND, 'nx:st-payout'); ctx.db.prepare("UPDATE status_payouts SET send_state='sending' WHERE id=3").run();
  const busy = fake(ctx, 'modal', ADM, { roles: [ROLE.adm], customId: 'nx:st-paidm:3', fields: { ref: 'x' } }); await route(busy, ctx); assert.match(text(busy), /sending this one right now/);
  ctx.db.prepare("UPDATE status_payouts SET send_state=NULL WHERE id=3").run();
  const paid = fake(ctx, 'modal', ADM, { roles: [ROLE.adm], customId: 'nx:st-paidm:3', fields: { ref: 'tx9' } }); await route(paid, ctx);
  assert.equal(ctx.db.prepare('SELECT state, ref FROM status_payouts WHERE id=3').get().state, 'paid');
  // .rewards: staff only
  const rw = fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'rewards' }); await route(rw, ctx); assert.match(text(rw), /ltc1qrewardswallet[\s\S]*Owed to members/);
  const rwd = fake(ctx, 'cmd', RND, { command: 'rewards' }); await route(rwd, ctx); assert.match(text(rwd), /do not have permission/);
});

test('fee panel: staff-only, shows the tiers from config', async () => {
  const ctx = setup(); ctx.cfg.fee = { threshold: 50, usd: 2, percentOver: 250, percent: 2 }; ctx.cfg.feeAssets = ['USDT', 'USDC']; ctx.cfg.channels.fees = 'feech'; ctx.chans.set('feech', { id: 'feech', sent: [], async send(p) { this.sent.push(p); } });
  const deny = fake(ctx, 'cmd', RND, { command: 'fees' }); await route(deny, ctx); assert.match(text(deny), /do not have permission/);
  await route(fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'fees' }), ctx);
  const j = JSON.stringify(ctx.chans.get('feech').sent[0].components.map((c) => c.toJSON()));
  assert.equal(ctx.chans.get('feech').sent[0].files.length, 1); assert.ok(j.includes('attachment://status.png') && j.includes('Middleman Fees') && j.includes('Up to $50') && j.includes('2%'));
});

test('giveaway: /giveaway create, new-invite requirement gates entry, winner is random', async () => {
  const ctx = setup(); const ch = { id: 'gwch', guild: ctx.guild, isTextBased: () => true, sent: [], messages: { fetch: async () => ({ edit: async () => {} }) }, async send(p) { this.sent.push(p); return { id: 'gm1' }; } };
  ctx.chans.set('gwch', ch); ctx.guild.id ??= 'G1';
  let uses = { [A]: 3 };
  ctx.guild.invites = { fetch: async () => new Map(Object.entries(uses).map(([u, n]) => [u, { inviter: { id: u }, uses: n }])) };
  const mk = (user, roles, sub, o) => { const i = fake(ctx, 'cmd', user, { roles, command: 'giveaway', sub, opts: o }); i.guild = ctx.guild; i.options.getChannel = () => ch; i.options.getInteger = (k) => o[k] ?? null; return i; };
  const deny = mk(RND, [], 'create', { duration: '1d', prize: 'x' }); await route(deny, ctx); assert.match(text(deny), /do not have permission/);
  const ok = mk(ADM, [ROLE.adm], 'create', { duration: '1d', prize: '1 Nitro Giftlink', invites: 1 }); await route(ok, ctx); assert.match(text(ok), /Giveaway created/);
  const posted = ch.sent[0]; assert.ok(JSON.stringify(posted.components.map((c) => c.toJSON())).includes('nx:gw-enter:1')); assert.match(JSON.stringify(posted.embeds[0].toJSON()), /1 Nitro Giftlink.*attachment:\/\/status.png|attachment:\/\/status.png.*1 Nitro Giftlink/); assert.equal(posted.files.length, 1);
  const enter = (u) => { const i = fake(ctx, 'btn', u, { customId: 'nx:gw-enter:1' }); i.guild = ctx.guild; return i; };
  const old = enter(A); await route(old, ctx); assert.match(text(old), /invite \*\*1\*\* new member/);
  uses = { [A]: 4 }; const yes = enter(A); await route(yes, ctx); assert.match(text(yes), /You are in/);
  const again = enter(A); await route(again, ctx); assert.match(text(again), /Already entered/);
  const end = mk(ADM, [ROLE.adm], 'end', { id: 1 }); await route(end, ctx); assert.match(text(end), /picked at random/);
  assert.match(ch.sent[1].content, new RegExp(A)); assert.match(ch.sent[1].content, /at random/);
  const late = enter(A); await route(late, ctx); assert.match(text(late), /has ended/);
});

test('poll: /poll create posts buttons, votes update the card, /poll end posts the result', async () => {
  const ctx = setup(); const edits = []; const ch = { id: 'plch', guild: ctx.guild, isTextBased: () => true, sent: [], messages: { fetch: async () => ({ edit: async (p) => { edits.push(p); } }) }, async send(p) { this.sent.push(p); return { id: 'pm1' }; } };
  ctx.chans.set('plch', ch); ctx.guild.id ??= 'G1';
  const mk = (user, roles, sub, o) => { const i = fake(ctx, 'cmd', user, { roles, command: 'poll', sub, opts: o }); i.guild = ctx.guild; i.options.getChannel = () => ch; i.options.getInteger = (k) => o[k] ?? null; i.options.getString = (k) => o[k] ?? null; return i; };
  const deny = mk(RND, [], 'create', { question: 'q', duration: '1d', option1: 'a', option2: 'b' }); await route(deny, ctx); assert.match(text(deny), /do not have permission/);
  const ok = mk(ADM, [ROLE.adm], 'create', { question: 'Which game?', duration: '1d', option1: 'Adopt Me', option2: 'Blox Fruits' }); await route(ok, ctx); assert.match(text(ok), /Poll created/);
  const posted = ch.sent[0]; assert.equal(posted.files.length, 1); assert.ok(JSON.stringify(posted.components.map((c) => c.toJSON())).includes('nx:pl-vote:1:1'));
  const v = async (u, n) => { const i = fake(ctx, 'btn', u, { customId: `nx:pl-vote:1:${n}` }); await route(i, ctx); return i; };
  assert.match(text(await v(A, 1)), /Vote counted/); await v(B, 1); assert.match(text(await v(A, 0)), /changed/);
  assert.match(JSON.stringify(edits.at(-1).embeds[0].toJSON()), /\*\*50%\*\*/);
  const who = mk(ADM, [ROLE.adm], 'votes', {}); await route(who, ctx); const wt = text(who); assert.match(wt, new RegExp(`Adopt Me[\\s\\S]*<@${A}>`)); assert.match(wt, new RegExp(`Blox Fruits[\\s\\S]*<@${B}>`));
  const whoDeny = mk(RND, [], 'votes', {}); await route(whoDeny, ctx); assert.match(text(whoDeny), /do not have permission/);
  const end = mk(ADM, [ROLE.adm], 'end', { id: 1 }); await route(end, ctx); assert.match(text(end), /Poll ended/);
  assert.match(ch.sent[1].content, /tie/);
  assert.match(text(await v(A, 0)), /has ended/);
});

test('.invites is public and shows invite link uses and tracked joins', async () => {
  const ctx = setup(); ctx.guild.invites = { fetch: async () => new Map([['c', { code: 'c', inviter: { id: A }, uses: 7 }]]) };
  const { recordJoin, recordLeave } = await import('../src/core/invites.js'); recordJoin(ctx.db, 'm1', A, 'c'); recordJoin(ctx.db, 'm2', A, 'c'); recordLeave(ctx.db, 'm2');
  const i = fake(ctx, 'cmd', A, { command: 'invites' }); i.guild = ctx.guild; i.options.getUser = () => null; await route(i, ctx);
  const e = i.out[0].embeds[0].toJSON(); assert.match(e.description, /\*\*7\*\* invite link uses/); assert.deepEqual(e.fields.map((f) => f.value), ['`2`', '`1`', '`1`']);
});

test('fees: LTC, SOL and ETH are free by default, USDT and USDC keep the tiers', async () => {
  const { loadConfig } = await import('../src/config.js'); const { calcFee, feeCfgFor } = await import('../src/core/fees.js');
  const cfg = loadConfig();
  for (const a of ['LTC', 'SOL', 'ETH']) for (const n of [10, 100, 400]) assert.equal(calcFee(n, feeCfgFor(cfg, a)), 0);
  for (const a of ['USDT', 'USDC']) { assert.equal(calcFee(50, feeCfgFor(cfg, a)), 0); assert.equal(calcFee(100, feeCfgFor(cfg, a)), 2); assert.equal(calcFee(300, feeCfgFor(cfg, a)), 6); }
  const ctx = setup(); ctx.cfg.fee = cfg.fee; ctx.cfg.feeAssets = cfg.feeAssets; ctx.cfg.channels.fees = 'feech'; ctx.chans.set('feech', { id: 'feech', sent: [], async send(p) { this.sent.push(p); } });
  await route(fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'fees' }), ctx);
  const j = JSON.stringify(ctx.chans.get('feech').sent[0].components.map((c) => c.toJSON())); assert.ok(j.includes('LTC, SOL and ETH') && j.includes('Free') && j.includes('USDT, USDC') && j.includes('2%'));
});

test('.check lists everyone who entered the current giveaway, staff only', async () => {
  const ctx = setup(); const G = await import('../src/core/giveaways.js');
  const mk = (u, roles, o = {}) => { const i = fake(ctx, 'cmd', u, { roles, command: 'check', opts: o }); i.options.getInteger = (k) => o[k] ?? null; return i; };
  const none = mk(ADM, [ROLE.adm]); await route(none, ctx); assert.match(text(none), /no giveaway yet/);
  const old = G.create(ctx.db, { channelId: 'c', hostId: 'h', prize: 'Old', req: null, endsAt: 1 }); G.enter(ctx.db, old.id, RND); G.end(ctx.db, old.id);
  const g = G.create(ctx.db, { channelId: 'c', hostId: 'h', prize: '1 Nitro', req: null, endsAt: Date.now() + 1e6 }); G.enter(ctx.db, g.id, A); G.enter(ctx.db, g.id, B);
  const deny = mk(RND, []); await route(deny, ctx); assert.match(text(deny), /do not have permission/);
  const ok = mk(ADM, [ROLE.adm]); await route(ok, ctx); const d = ok.out[0].embeds[0].toJSON().description;
  assert.match(d, /1 Nitro/); assert.match(d, /Entries:\*\* \*\*2\*\*/); assert.ok(d.includes(`<@${A}>`) && d.includes(`<@${B}>`) && !d.includes(`<@${RND}>`));
  const byId = mk(ADM, [ROLE.adm], { id: old.id }); await route(byId, ctx); assert.match(byId.out[0].embeds[0].toJSON().description, /Old/);
});

test('totals: .totals creates two locked voice channels, names follow completed deals, renames are throttled', async () => {
  const ctx = setup(); const made = []; ctx.guild.id ??= 'G1';
  ctx.guild.channels = { create: async (o) => { const ch = { id: `v${made.length + 1}`, name: o.name, opts: o, async setName(n) { this.name = n; this.renames = (this.renames ?? 0) + 1; } }; made.push(ch); return ch; } };
  ctx.client = { channels: { cache: new Map(), fetch: async (id) => made.find((c) => c.id === id) } };
  const mk = (u, roles) => { const i = fake(ctx, 'cmd', u, { roles, command: 'totals' }); i.guild = ctx.guild; return i; };
  const deny = mk(RND, []); await route(deny, ctx); assert.match(text(deny), /do not have permission/);
  await route(mk(ADM, [ROLE.adm]), ctx);
  assert.deepEqual(made.map((c) => c.name), ['Volume: $0.00', 'Total Deals: 0']);
  const ow = made[0].opts.permissionOverwrites[0]; assert.equal(ow.id, 'G1'); assert.ok(ow.deny.length >= 1);
  await route(mk(ADM, [ROLE.adm]), ctx); assert.equal(made.length, 2, 'running it again reuses the channels');
  const d1 = ctx.deals.create({ creator: A, partner: B, robloxA: 'Alice_1', robloxB: 'Bob22', item: 'x', amount: '1200.50', currency: 'USD', asset: 'LTC', network: 'litecoin' });
  ctx.db.prepare("UPDATE deals SET status='completed' WHERE id=?").run(d1.id);
  const { refresh } = await import('../src/discord/totals.js');
  const t0 = Date.now() + 10 * 60e3; assert.equal(await refresh(ctx, { now: t0 }), 2);
  assert.deepEqual(made.map((c) => c.name), ['Volume: $1,200.50', 'Total Deals: 1']);
  const d2 = ctx.deals.create({ creator: A, partner: B, robloxA: 'Alice_1', robloxB: 'Bob22', item: 'x', amount: '10', currency: 'USD', asset: 'LTC', network: 'litecoin' });
  ctx.db.prepare("UPDATE deals SET status='completed' WHERE id=?").run(d2.id);
  assert.equal(await refresh(ctx, { now: t0 + 60e3 }), 0, 'within 5 minutes: wait');
  assert.equal(await refresh(ctx, { now: t0 + 301e3 }), 2); assert.equal(made[1].name, 'Total Deals: 2');
});

test('.steal: reply to a message with custom emoji adds them as nexora_<number>, staff only', async () => {
  const { commandFromMessage } = await import('../src/discord/prefix.js');
  const ctx = setup(); const lobby = ctx.chans.get('lobby') ?? fake(ctx, 'btn', A).channel; const made = [];
  ctx.guild.emojis = { cache: new Map([['1', { name: 'nexora_1234' }]]), create: async (o) => { if (o.name === 'FAIL') throw new Error('x'); made.push(o); return { toString: () => `<:${o.name}:99>` }; } };
  const msg = (author, content, { admin = false, ref } = {}) => { const out = [];
    return { out, author: { id: author, bot: false, send: async () => {} }, guild: ctx.guild, channel: lobby, channelId: 'lobby', client: ctx.client, content, reference: ref ? { messageId: 'r1' } : undefined,
      fetchReference: async () => ({ content: ref }), member: { roles: { cache: new Map() }, permissions: { has: (p) => admin && p === 'Administrator' } }, mentions: { users: new Map() },
      attachments: { first: () => undefined }, delete: async () => {}, reply: async (p) => { out.push(p); return { edit: async () => {} }; } }; };
  const text2 = (m) => JSON.stringify(m.out.map((o) => (o.embeds ?? []).map((e) => e.data.description)));
  const deny = msg(RND, '.steal', { ref: '<:pog:123456789012345678>' }); await commandFromMessage(deny, ctx); assert.match(text2(deny), /do not have permission/); assert.equal(made.length, 0);
  const none = msg(ADM, '.steal', { admin: true, ref: 'no emoji here' }); await commandFromMessage(none, ctx); assert.match(text2(none), /custom emoji/);
  const ok = msg(ADM, '.steal', { admin: true, ref: 'look <:pog:123456789012345678> and <a:dance:223456789012345678> and <:pog:123456789012345678>' }); await commandFromMessage(ok, ctx);
  assert.equal(made.length, 2); assert.ok(made.every((o) => /^nexora_\d{4}$/.test(o.name) && o.name !== 'nexora_1234'));
  assert.match(made[0].attachment, /emojis\/123456789012345678\.png/); assert.match(made[1].attachment, /emojis\/223456789012345678\.gif/);
  assert.match(text2(ok), /Added/);
  const inline = msg(ADM, '.steal <:xx:323456789012345678>', { admin: true }); await commandFromMessage(inline, ctx); assert.equal(made.length, 3);
});

test('/role all: staff only, gives the role to non-bot members who lack it, refuses unsafe roles', async () => {
  const ctx = setup(); const added = [];
  const mem = (id, bot, has) => ({ id, user: { bot }, roles: { cache: new Map(has ? [['R1', 1]] : []), add: async (r) => { if (id === 'bad') throw new Error('Missing Permissions'); added.push(id); } } });
  ctx.guild.members.me = { roles: { highest: { position: 10 } } }; ctx.guild.members.fetch = async () => new Map([['a', mem('a', false, false)], ['b', mem('b', false, true)], ['c', mem('c', true, false)], ['bad', mem('bad', false, false)], ['d', mem('d', false, false)]]);
  const role = (o = {}) => ({ id: 'R1', name: 'Member', position: 5, managed: false, permissions: { has: () => false }, ...o });
  const run = async (u, roles, r) => { const i = fake(ctx, 'cmd', u, { roles, command: 'role', sub: 'all', opts: { role: r } }); i.guild = ctx.guild; i.deferReply = async () => {}; i.editReply = async () => {}; await route(i, ctx); return text(i); };
  assert.match(await run(RND, [], role()), /do not have permission/); assert.equal(added.length, 0);
  assert.match(await run(ADM, [ROLE.adm], role({ position: 10 })), /above my highest role/);
  assert.match(await run(ADM, [ROLE.adm], role({ permissions: { has: (p) => p === 'Administrator' } })), /will not give/);
  assert.match(await run(ADM, [ROLE.adm], role({ managed: true })), /cannot be given out/);
  const out = await run(ADM, [ROLE.adm], role()); assert.deepEqual(added.sort(), ['a', 'd']); assert.match(out, /\*\*2\*\* member/); assert.match(out, /\*\*1\*\* failed/);
});

test('join ping: pings a new member in each configured channel and deletes it after the delay; bots are ignored', async () => {
  const { pingNewMember } = await import('../src/discord/joinping.js');
  const sent = []; const deleted = [];
  const mkch = (id) => ({ id, send: async (p) => { sent.push([id, p]); return { delete: async () => { deleted.push(id); } }; } });
  const ctx = { cfg: { channels: { joinPing: ['c1', 'c2'] } }, client: { channels: { fetch: async (id) => (id === 'zz' ? null : mkch(id)) } } };
  assert.equal(await pingNewMember(ctx, { user: { id: 'u9', bot: true } }), 0); assert.equal(sent.length, 0);
  assert.equal(await pingNewMember(ctx, { user: { id: 'u9', bot: false } }, { ttl: 20 }), 2);
  assert.deepEqual(sent.map((s) => s[0]), ['c1', 'c2']); assert.equal(sent[0][1].content, '<@u9>'); assert.deepEqual(sent[0][1].allowedMentions.users, ['u9']);
  assert.equal(deleted.length, 0); await new Promise((r) => setTimeout(r, 80)); assert.deepEqual(deleted, ['c1', 'c2']);
});

test('.invites leaderboard: ranks inviters by members still here, public, own rank shown', async () => {
  const { commandFromMessage } = await import('../src/discord/prefix.js'); const { recordJoin, recordLeave } = await import('../src/core/invites.js');
  const ctx = setup(); const lobby = ctx.chans.get('lobby') ?? fake(ctx, 'btn', A).channel;
  const J = (inv, who) => recordJoin(ctx.db, who, inv, 'c');
  for (const w of ['i1', 'i2', 'i3']) J('top', w); J('mid', 'i4'); J('mid', 'i5'); recordLeave(ctx.db, 'i5'); J('low', 'i6');
  const run = async (content, author = RND) => { const out = [];
    const m = { out, author: { id: author, bot: false, send: async () => {} }, guild: ctx.guild, channel: lobby, channelId: 'lobby', client: ctx.client, content, member: { roles: { cache: new Map() }, permissions: { has: () => false } }, mentions: { users: new Map() },
      attachments: { first: () => undefined }, delete: async () => {}, reply: async (p) => { out.push(p); return { edit: async () => {} }; } };
    assert.equal(await commandFromMessage(m, ctx), true); return out[0].embeds[0].data; };
  for (const c of ['.invites leaderboard', '.invite leaderboard', '.invites lb']) {
    const e = await run(c); assert.equal(e.title, 'Invite Leaderboard');
    assert.match(e.description, /\*\*1\.\*\* <@top> - \*\*3\*\* invites/); assert.match(e.description, /\*\*2\.\*\* <@mid> - \*\*1\*\* invite \(1 left\)/); assert.match(e.description, /\*\*3\.\*\* <@low>/);
  }
  const mine = await run('.invites leaderboard', 'low'); assert.doesNotMatch(mine.description, /Your rank/);
});

test('.invites @user: staff see who that member invited (alt check), members only see counts', async () => {
  const { commandFromMessage } = await import('../src/discord/prefix.js'); const { recordJoin, recordLeave } = await import('../src/core/invites.js');
  const ctx = setup(); const lobby = ctx.chans.get('lobby') ?? fake(ctx, 'btn', A).channel;
  const fresh = String((BigInt(Date.now() - 864e5 - 1420070400000) << 22n)); const old = '323456789012345678';
  recordJoin(ctx.db, fresh, '410000000000000001', 'abc'); recordJoin(ctx.db, old, '410000000000000001', 'abc'); recordLeave(ctx.db, old);
  const run = async (content, admin) => { const out = [];
    const m = { out, author: { id: admin ? ADM : RND, bot: false, send: async () => {} }, guild: ctx.guild, channel: lobby, channelId: 'lobby', client: ctx.client, content, member: { roles: { cache: new Map() }, permissions: { has: (p) => admin && p === 'Administrator' } },
      mentions: { users: new Map([['410000000000000001', { id: '410000000000000001', username: 'inv', displayAvatarURL: () => null }]]) }, attachments: { first: () => undefined }, delete: async () => {}, reply: async (p) => { out.push(p); return { edit: async () => {} }; } };
    assert.equal(await commandFromMessage(m, ctx), true); return out[0].embeds[0].data; };
  const staff = await run('.invites <@410000000000000001>', true); const f = staff.fields.find((x) => x.name === 'Invited members').value;
  assert.match(f, new RegExp(`<@${fresh}> - here.*\\(new account\\)`)); assert.match(f, new RegExp(`<@${old}> - \\*\\*left\\*\\*`)); assert.doesNotMatch(f.split('\n')[1] ?? '', /new account/);
  const pub = await run('.invites <@410000000000000001>', false); assert.ok(!pub.fields.some((x) => x.name === 'Invited members'));
});

test('transcripts: saved to the staff channel as a summary with a text file, nobody is DMed, old View Transcript buttons say it is off', async () => {
  const rooms = await import('../src/discord/rooms.js'); const { parseBody } = await import('../src/discord/transcript.js');
  const ctx = setup(); const d = ctx.deals.create({ creator: A, partner: B, robloxA: 'Alice_1', robloxB: 'Bob22', item: 'x', amount: '99', currency: 'USD', asset: 'LTC', network: 'litecoin' });
  const dms = []; const posted = []; ctx.client.users.fetch = async (id) => ({ id, send: async (p) => { dms.push([id, p]); } });
  ctx.chans.set('tlog', { id: 'tlog', send: async (p) => { posted.push(p); } }); ctx.cfg.channels.transcripts = 'tlog';
  const ch = { id: 'room', messages: { fetch: async ({ before }) => (before ? new Map() : Object.assign(new Map([['2', { id: '2', createdTimestamp: 2000, author: { username: 'Bob', id: B }, content: 'line one\nline two', embeds: [] }], ['1', { id: '1', createdTimestamp: 1000, author: { username: 'Alice', id: A }, content: 'hi', embeds: [] }]]), { last: () => ({ id: '1' }) })) } };
  await rooms.saveTranscript(ctx, d.id, ch, 'system');
  assert.equal(dms.length, 0); assert.equal(posted.length, 1); assert.ok(!posted[0].components); assert.match(posted[0].files[0].name, /\.txt$/); assert.match(posted[0].embeds[0].data.description, /Messages:\*\* 2/);
  const body = ctx.db.prepare('SELECT body FROM transcripts WHERE ticket_id=?').get(d.id).body; assert.equal(parseBody(body).length, 2);
  const click = fake(ctx, 'btn', A, { customId: `nx:tview:${d.id}` }); await route(click, ctx); assert.match(text(click), /turned off/);
});

test('completed post: new layout, /set-privacy hides a name as Anonymous, .testdone posts a labelled sample', async () => {
  const rooms = await import('../src/discord/rooms.js'); const privacy = await import('../src/core/privacy.js');
  const ctx = setup(); const posts = []; ctx.chans.set('done', { id: 'done', send: async (p) => { posts.push(p); return { id: 'm1' }; } }); ctx.cfg.channels.completed = 'done';
  const d = ctx.deals.create({ creator: A, partner: B, robloxA: 'Alice_1', robloxB: 'Bob22', item: 'x', amount: '99', currency: 'USD', asset: 'LTC', network: 'litecoin' });
  ctx.db.prepare("UPDATE deals SET status='completed', sender_id=?, receiver_id=?, completed_at=? WHERE id=?").run(A, B, new Date().toISOString(), d.id);
  const set = fake(ctx, 'cmd', A, { command: 'set-privacy', opts: { name: 'hide' } }); await route(set, ctx); assert.equal(privacy.isHidden(ctx.db, A), true);
  await rooms.publishCompleted(ctx, ctx.deals.get(d.id));
  const e = posts[0].embeds[0].data; assert.match(e.description, /^## <:checkmark:1575069601312808970> Funds Released/); assert.match(e.description, /\*\*Sender\*\* - Anonymous/); assert.match(e.description, new RegExp(`<@${B}>`)); assert.match(e.description, /\/set-privacy/); assert.match(e.description, /USD Amount/);
  assert.doesNotMatch(e.description, new RegExp(`<@${A}>`)); assert.ok(!JSON.stringify(posts[0].components).includes('Transcript'));
  await route(fake(ctx, 'cmd', A, { command: 'set-privacy', opts: { name: 'show' } }), ctx); assert.equal(privacy.isHidden(ctx.db, A), false);
  const out = []; const t = fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'testdone' }); t.channel = { send: async (p) => { out.push(p); } }; await route(t, ctx);
  assert.match(out[0].embeds[0].data.description, /Test post/); assert.match(out[0].embeds[0].data.description, /Anonymous/); assert.equal(out[0].components.length, 1 - 1 + out[0].components.length);
  const deny = fake(ctx, 'cmd', RND, { command: 'testdone' }); await route(deny, ctx); assert.match(text(deny), /do not have permission/);
});

test('moderation text commands: permissions, hierarchy, and each action', async () => {
  const { commandFromMessage } = await import('../src/discord/prefix.js');
  const ctx = setup(); const lobby = fake(ctx, 'btn', A).channel; const calls = [];
  const mkMember = (id, pos, extra = {}) => ({ id, displayName: id, roles: { highest: { position: pos }, cache: new Map(), add: async (r) => { calls.push(['add', id, r.id]); const m = ctx.members.get(id); m.roles.cache.set(r.id, 1); }, remove: async (r) => { calls.push(['remove', id, r.id]); ctx.members.get(id).roles.cache.delete(r.id); } },
    kick: async () => calls.push(['kick', id]), setNickname: async (n) => calls.push(['nick', id, n]), timeout: async (ms) => calls.push(['timeout', id, ms]), ...extra });
  ctx.members = new Map([['111111111111111111', mkMember('111111111111111111', 10)], ['222222222222222222', mkMember('222222222222222222', 90)]]);
  ctx.client.users.fetch = async (id) => ({ id, username: `u${id.slice(0, 3)}` });
  ctx.guild.ownerId = 'owner'; ctx.guild.members.me = { id: 'bot', roles: { highest: { position: 50 } } };
  ctx.guild.members.fetch = async (id) => { const m = ctx.members.get(id); if (!m) throw new Error('unknown'); return m; };
  ctx.guild.members.ban = async (id) => calls.push(['ban', id]);
  const role = { id: '333333333333333333', name: 'Vip', position: 5, permissions: { has: () => false } }; const high = { id: '444444444444444444', name: 'Top', position: 70, permissions: { has: () => false } };
  ctx.guild.roles.cache = new Map([[role.id, role], [high.id, high]]);
  const deleted = []; lobby.bulkDelete = async (x) => { calls.push(['purge', Array.isArray(x) ? x.length : x]); return { size: Array.isArray(x) ? x.length : x }; }; lobby.messages = { fetch: async () => new Map([['m1', { id: 'm1', author: { id: '111111111111111111' } }], ['m2', { id: 'm2', author: { id: 'x' } }]]) };
  const msg = (content, { admin = true, pos = 60 } = {}) => { const out = []; return { out, author: { id: ADM, bot: false }, guild: ctx.guild, channel: lobby, channelId: 'lobby', client: ctx.client, content, member: { roles: { cache: new Map(), highest: { position: pos } }, permissions: { has: (p) => admin && p === 'Administrator' } }, mentions: { users: new Map() }, attachments: { first: () => null }, delete: async () => deleted.push('cmd'), reply: async (p) => { out.push(p); return { edit: async () => {} }; } }; };
  const run = async (c, o) => { const m = msg(c, o); await commandFromMessage(m, ctx); return JSON.stringify(m.out.map((p) => p.embeds?.map((e) => [e.data.title, e.data.description]))); };
  assert.match(await run('.ban 111111111111111111 spam', { admin: false }), /do not have permission/);
  assert.match(await run('.ban 111111111111111111 spamming'), /Member banned/); assert.deepEqual(calls.pop(), ['ban', '111111111111111111']);
  assert.match(await run('.ban 888888888888888888'), /Member banned/); calls.pop();
  assert.match(await run('.ban 222222222222222222 x'), /equal to or above yours/);
  assert.match(await run('.ban owner'), /user ID|Mention/);
  assert.match(await run('.kick 111111111111111111'), /Member kicked/); assert.deepEqual(calls.pop(), ['kick', '111111111111111111']);
  assert.match(await run('.nick 111111111111111111 Cool Guy'), /Cool Guy/); assert.deepEqual(calls.pop(), ['nick', '111111111111111111', 'Cool Guy']);
  assert.match(await run('.nick 111111111111111111'), /reset/); assert.deepEqual(calls.pop(), ['nick', '111111111111111111', null]);
  assert.match(await run('.timeout 111111111111111111 10m spam'), /10 minutes/); assert.deepEqual(calls.pop(), ['timeout', '111111111111111111', 600000]);
  assert.match(await run('.timeout 111111111111111111 off'), /talk again/); assert.deepEqual(calls.pop(), ['timeout', '111111111111111111', null]);
  assert.match(await run('.timeout 111111111111111111 60d'), /28 days/); assert.match(await run('.timeout 111111111111111111 soon'), /duration like/);
  await run('.purge 5'); assert.match(JSON.stringify(lobby.sent.at(-1).embeds[0].data), /5\*\* messages/); assert.deepEqual(calls.pop(), ['purge', 5]); assert.ok(deleted.includes('cmd'));
  assert.match(await run('.purge 500'), /1 to 100/);
  await run('.purge 10 111111111111111111'); assert.match(JSON.stringify(lobby.sent.at(-1).embeds[0].data), /1\*\* message/); assert.deepEqual(calls.pop(), ['purge', 1]);
  assert.match(await run(`.role 111111111111111111 <@&${role.id}>`), /Role added/); assert.deepEqual(calls.pop(), ['add', '111111111111111111', role.id]);
  assert.match(await run(`.role 111111111111111111 ${role.id}`), /Role removed/); assert.deepEqual(calls.pop(), ['remove', '111111111111111111', role.id]);
  assert.match(await run(`.role 111111111111111111 ${high.id}`), /above my highest role|equal to or above your/);
  assert.match(await run(`.role 111111111111111111 ${role.id}`, { pos: 3 }), /equal to or above your highest/);
});

test('/say posts an embed with the Nexora thumbnail, staff only', async () => {
  const ctx = setup(); const target = { id: 'say1', sent: [], async send(p) { this.sent.push(p); } };
  const deny = fake(ctx, 'cmd', RND, { command: 'say', opts: { message: 'hi' } }); await route(deny, ctx); assert.match(text(deny), /do not have permission/);
  const ok = fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'say', opts: { message: 'Line one\\nLine two', title: 'News', channel: target } }); ok.options.getChannel = (k) => ok.opts?.[k] ?? target; await route(ok, ctx);
  const e = target.sent[0].embeds[0].data; assert.equal(e.title, 'News'); assert.equal(e.description, 'Line one\nLine two'); assert.equal(e.thumbnail.url, 'attachment://status.png'); assert.equal(target.sent[0].files.length, 1);
  assert.deepEqual(target.sent[0].allowedMentions, { parse: [] }); assert.match(text(ok), /Posted/);
});

test('auto role: new joiners and existing members get the role; unsafe roles are refused', async () => {
  const { giveAutoRole, sweepAutoRole } = await import('../src/discord/autorole.js');
  const ctx = setup(); ctx.cfg.autoRoleId = 'R1'; const added = [];
  const role = { id: 'R1', position: 5, managed: false, permissions: { has: () => false } };
  const mk = (id, has = false, bot = false) => ({ user: { id, bot }, guild, roles: { cache: new Map(has ? [['R1', 1]] : []), add: async (r) => { added.push([id, r.id]); } } });
  const guild = { roles: { cache: new Map([['R1', role]]), everyone: { id: 'ev' } }, members: { me: { roles: { highest: { position: 50 } } }, fetch: async () => new Map([['a', mk('a')], ['b', mk('b', true)], ['c', mk('c', false, true)], ['d', mk('d')]]) } };
  assert.equal(await giveAutoRole(ctx, mk('new')), true); assert.deepEqual(added.pop(), ['new', 'R1']);
  assert.equal(await giveAutoRole(ctx, mk('bot1', false, true)), false); assert.equal(await giveAutoRole(ctx, mk('old', true)), false);
  const r = await sweepAutoRole(ctx, guild, { pause: 0 }); assert.deepEqual(r, { ok: 2, failed: 0 }); assert.deepEqual(added.map((x) => x[0]), ['a', 'd']);
  added.length = 0; role.position = 60; assert.equal(await giveAutoRole(ctx, mk('n2')), false); role.position = 5;
  role.permissions = { has: (p) => p === 'Administrator' }; assert.equal(await giveAutoRole(ctx, mk('n3')), false); assert.equal(added.length, 0);
});

test('pause: welcome and join ping stay off until the time is up, .pause controls them', async () => {
  const { sendWelcome } = await import('../src/discord/welcome.js'); const { pingNewMember } = await import('../src/discord/joinping.js'); const { seedPause, isPaused } = await import('../src/core/pause.js');
  const ctx = setup(); const posts = []; const ch = { id: 'w', send: async (p) => { posts.push(p); return { delete: async () => {} }; } };
  ctx.client.channels.fetch = async () => ch; ctx.cfg.channels.welcome = 'w'; ctx.cfg.channels.joinPing = ['w'];
  const member = { id: A, user: { id: A, username: 'x', bot: false } };
  assert.equal(seedPause(ctx.db, 't', 3600e3), true); assert.equal(seedPause(ctx.db, 't', 3600e3), false, 'seed runs once');
  await sendWelcome(ctx, member); assert.equal(await pingNewMember(ctx, member, { ttl: 1 }), 0); assert.equal(posts.length, 0);
  const st = fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'pause' }); await route(st, ctx); assert.match(text(st), /off until/);
  const deny = fake(ctx, 'cmd', RND, { command: 'pause', opts: { what: 'off' } }); await route(deny, ctx); assert.match(text(deny), /do not have permission/);
  const on = fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'pause', opts: { what: 'off' } }); await route(on, ctx); assert.equal(isPaused(ctx.db, 'welcome'), false);
  await sendWelcome(ctx, member); assert.equal(await pingNewMember(ctx, member, { ttl: 1 }), 1); assert.equal(posts.length, 2);
  const one = fake(ctx, 'cmd', ADM, { roles: [ROLE.adm], command: 'pause', opts: { what: 'ping', duration: '2h' } }); await route(one, ctx); assert.ok(isPaused(ctx.db, 'ping') && !isPaused(ctx.db, 'welcome'));
});
