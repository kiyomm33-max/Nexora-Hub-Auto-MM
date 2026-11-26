// Text commands: ".stats", ".staff history NXH-...", ".help". They run through the same handlers as the slash commands
// by wrapping the chat message in an object that looks like a slash-command interaction.
import { route, staffOf, UserError } from './handlers.js';
import * as ui from './ui.js';
import { log } from '../logger.js';

const PUBLIC = new Set(['trust', 'stats', 'help', 'leaderboard', 'messages', 'invites', 'inviteboard']);
const ALIASES = { invite: 'invites', top: 'leaderboard', lb: 'leaderboard', msgs: 'messages', mymessages: 'messages', statuspanel: 'status', rewards: 'status' };

// arg: [name, type, required]. Types: string, int, user, rest (everything that is left).
const D = ['deal_id', 'string', true];
export const SPEC = {
  help: { desc: 'Show every command', args: [] },
  leaderboard: { desc: 'Message leaderboard (today, week, month or all)', args: [['period', 'string', false]] },
  messages: { desc: 'How many messages a member sent', args: [['member', 'user', false]] },
  inviteboard: { desc: 'Top inviters (also: .invites leaderboard)', args: [] },
  invites: { desc: 'How many people a member invited', args: [['member', 'user', false]] },
  check: { desc: 'Show everyone who entered the current giveaway', args: [['id', 'int', false]] },
  totals: { desc: 'Create the locked voice channels showing total volume and deals', args: [] },
  steal: { desc: 'Add a custom emoji to this server (reply to a message with it, or put it after the command)', args: [['emoji', 'rest', false]] },
  testdone: { desc: 'Post a sample completed-deal message in this channel', args: [] },
  ban: { desc: 'Ban a member (mention or ID, works for people who left)', args: [['member', 'user', true], ['reason', 'rest', false]], textOnly: true },
  kick: { desc: 'Kick a member', args: [['member', 'user', true], ['reason', 'rest', false]], textOnly: true },
  nick: { desc: 'Change a member\'s nickname (leave it empty to reset)', args: [['member', 'user', true], ['nickname', 'rest', false]], textOnly: true },
  timeout: { desc: 'Time a member out: 10m, 2h, 1d, up to 28d (off removes it)', args: [['member', 'user', true], ['duration', 'string', true], ['reason', 'rest', false]], textOnly: true },
  purge: { desc: 'Delete the last 1 to 100 messages here, optionally only from one member', args: [['amount', 'int', true], ['member', 'user', false]], textOnly: true },
  role: { desc: 'Add a role to a member, or remove it if they have it. `.role all @role` gives it to everyone', args: [['member', 'user', true], ['role', 'role', true]], textOnly: true },
  say: { desc: 'Post an embed with the Nexora thumbnail (also /say)', args: [['message', 'rest', true]], textOnly: true },
  pause: { desc: 'Turn the welcome message and join ping off for a while: `.pause welcome|ping|both 12h`, `.pause off`, or `.pause` to see the status', args: [['what', 'string', false], ['duration', 'string', false]], textOnly: true },
  votes: { desc: 'Show who voted for what in a poll (latest poll by default)', args: [['id', 'int', false]], textOnly: true },
  rewards: { desc: 'Show the status rewards wallet: deposit address, balance and what is owed', args: [] },
  tag: { desc: 'Server tag and status history of a member', args: [['member', 'user', false]] },
  tags: { desc: 'Server tag and status leaderboard', args: [] },
  trust: { desc: 'Trust tier, verified volume and progress to the next tier (also /trust)', args: [['member', 'user', false]], textOnly: true },
  stats: { desc: 'Deal stats and rank', args: [['member', 'user', false]] },
  vouch: { desc: 'Leave feedback for a completed deal', args: [D, ['rating', 'int', true], ['feedback', 'rest', true]] },
  ticket: { desc: 'Open a private support ticket', args: [['text', 'rest', true]] },
  dispute: { desc: 'Open a dispute on a deal', args: [D, ['reason', 'rest', true]] },
  evidence: { desc: 'Submit evidence (attach a file to the message)', args: [D, ['note', 'rest', true]] },
  mydeals: { desc: 'List your recent deals', args: [] },
  dealinfo: { desc: 'Live status of a deal', args: [D] },
  panel: { desc: 'Post the deal panel', args: [] },
  welcome: { desc: 'Post a welcome message preview', args: [] },
  fees: { desc: 'Post the fee explanation panel', args: [] },
  rules: { desc: 'Post the server rules', args: [] },
  trustpanel: { desc: 'Post the trust system panel', args: [], textOnly: true },
  status: { desc: 'Post the Status Rewards panel', args: [] },
  clearpayouts: { desc: 'Reject all open status payout requests and close their rooms', args: [], textOnly: true },
  supportpanel: { desc: 'Post the support panel', args: [] },
  staff: {
    desc: 'Staff tools',
    subs: {
      history: { desc: 'Audit history of a deal', args: [D] },
      activity: { desc: 'Staff activity log', args: [['member', 'user', false]] },
      claim: { desc: 'Claim a deal as its middleman', args: [D] },
      cancel: { desc: 'Cancel a deal before funds are involved', args: [D, ['reason', 'rest', true]] },
      simulate: { desc: 'Demo only: simulate a provider event', args: [D, ['event', 'string', true]] },
      audit: { desc: 'Verify the audit log hash chain', args: [] },
      backup: { desc: 'Create a database backup now', args: [] },
      wallet: { desc: 'Owner only: wallet and recovery phrase (sent by DM)', args: [], dm: true },
      lockrooms: { desc: 'Owner only: hide open rooms from roles below admin', args: [] },
      refund: { desc: 'Owner only: send a deal\'s funds to an address', args: [D, ['address', 'string', true]] },
    },
  },
};

const argName = ([n, , req]) => (req ? `<${n}>` : `[${n}]`);
export const usageOf = (prefix, name, sub, spec) => `${prefix}${name}${sub ? ` ${sub}` : ''}${spec.args.length ? ` ${spec.args.map(argName).join(' ')}` : ''}`;

/** All usage lines, for .help. Members only see the public commands. */
export function helpLines(prefix, { all }) {
  const out = [];
  for (const [name, s] of Object.entries(SPEC)) {
    if (!all && !PUBLIC.has(name)) continue;
    if (s.subs) for (const [sub, ss] of Object.entries(s.subs)) out.push(`\`${usageOf(prefix, name, sub, ss)}\`  ${ss.desc}`);
    else out.push(`\`${usageOf(prefix, name, null, s)}\`  ${s.desc}`);
  }
  return out;
}

const USER_RE = /^<@!?(\d{15,25})>$|^(\d{15,25})$/;

/** Split "a b rest of the text" into the values for `args`. Throws UserError with the usage line when something is missing or malformed. */
export async function parseArgs(raw, args, { usage, resolveUser, resolveRole }) {
  const toks = [...raw.matchAll(/\S+/g)].map((m) => ({ v: m[0], at: m.index }));
  const vals = {}; let k = 0;
  for (const [name, type, req] of args) {
    const t = toks[k];
    if (!t) { if (req) throw new UserError(`Usage: \`${usage}\``); continue; }
    if (type === 'rest') { vals[name] = raw.slice(t.at).trim(); k = toks.length; continue; }
    k++;
    if (type === 'int') { if (!/^-?\d{1,6}$/.test(t.v)) throw new UserError(`\`${name}\` must be a number. Usage: \`${usage}\``); vals[name] = Number(t.v); }
    else if (type === 'user') {
      const m = USER_RE.exec(t.v); if (!m) throw new UserError(`Mention a member or send their user ID. Usage: \`${usage}\``);
      vals[name] = await resolveUser(m[1] ?? m[2]);
    } else if (type === 'role') {
      const m = /^<@&(\d{15,25})>$|^(\d{15,25})$/.exec(t.v); if (!m) throw new UserError(`Mention a role or send its ID. Usage: \`${usage}\``);
      vals[name] = await resolveRole(m[1] ?? m[2]);
    } else vals[name] = t.v;
  }
  return vals;
}

function optionsOf(sub, vals, attachment) {
  const get = (n, req) => { const v = vals[n]; if (v === undefined && req) throw new UserError(`Missing \`${n}\`.`); return v ?? null; };
  return { getSubcommand: () => sub, getString: get, getInteger: get, getUser: (n) => vals[n] ?? null, getRole: (n, req) => { const v = vals[n]; if (!v && req) throw new UserError(`Missing \`${n}\`.`); return v ?? null; }, getAttachment: () => attachment ?? null };
}

/** Looks enough like a ChatInputCommandInteraction for the command handlers. Replies go to the channel as a reply to the message. */
function interactionFrom(msg, name, options, { dm = false } = {}) {
  let sent = null;
  const clean = (p) => {
    const { flags, ...rest } = p;
    return { ...rest, ...(flags && flags & (1 << 15) ? { flags: 1 << 15 } : {}), allowedMentions: { repliedUser: false, ...(p.allowedMentions ?? {}) } };
  };
  const send = async (p) => {
    if (dm) {
      try { return await msg.author.send({ ...clean(p), allowedMentions: { parse: [] } }); }
      catch { return msg.reply({ content: 'I could not DM you. Open your DMs for this server and run the command again. I never post this in a channel.', allowedMentions: { repliedUser: false } }); }
    }
    return msg.reply(clean(p));
  };
  const i = {
    prefix: true, message: msg, commandName: name, options, user: msg.author, member: msg.member, guild: msg.guild, channel: msg.channel, channelId: msg.channelId,
    memberPermissions: msg.member?.permissions, deferred: false, replied: false,
    isChatInputCommand: () => true, isButton: () => false, isModalSubmit: () => false,
    async reply(p) { i.replied = true; sent = await send(p); return sent; },
    async deferReply() { i.deferred = true; msg.channel?.sendTyping?.()?.catch?.(() => {}); },
    async editReply(p) { if (sent?.edit) { try { return await sent.edit(clean(p)); } catch { /* fall through and send a new message */ } } i.replied = true; sent = await send(p); return sent; },
    async followUp(p) { return send(p); },
    async showModal() { throw new UserError('That needs a form; use the button on the panel instead.'); },
  };
  return i;
}

/** Message handler: runs a text command if the message is one. Returns true when it handled the message. */
export async function commandFromMessage(msg, ctx) {
  const prefix = ctx.cfg.prefix ?? '.';
  if (!msg.guild || msg.author?.bot || typeof msg.content !== 'string' || !msg.content.startsWith(prefix)) return false;
  const body = msg.content.slice(prefix.length).replace(/^invites?\s+(?:leaderboard|lb|top)\s*$/i, 'inviteboard');
  const head = /^([a-z]+)(?:\s+|$)/i.exec(body); if (!head) return false;
  const typed = head[1].toLowerCase(); const name = ALIASES[typed] ?? typed; const spec = SPEC[name]; if (!spec) return false; // other bots use the same prefix: stay quiet
  let rest = body.slice(head[0].length);
  const reply = (p) => msg.reply({ ...p, allowedMentions: { repliedUser: false } }).catch((e) => log.error('prefix reply failed', e));
  const err = (text) => reply({ embeds: [ui.errorEmbed(ctx.cfg, text)] });
  try {
    const probe = interactionFrom(msg, name, null);
    const staff = !!msg.member?.permissions?.has?.('Administrator') || !!staffOf(probe, ctx);
    if (!PUBLIC.has(name) && !staff) { await err('You do not have permission to use that command.'); return true; }
    if (name === 'help') {
      await reply({ embeds: [ui.base(ctx.cfg, 'Commands', helpLines(prefix, { all: staff }).join('\n'))] });
      return true;
    }
    let sub = null; let s = spec;
    if (spec.subs) {
      const m = /^([a-z]+)(?:\s+|$)/i.exec(rest); sub = m?.[1]?.toLowerCase();
      if (!sub || !spec.subs[sub]) { await err(`Usage: \`${prefix}${name} <${Object.keys(spec.subs).join('|')}>\``); return true; }
      s = spec.subs[sub]; rest = rest.slice(m[0].length);
    }
    if (name === 'role' && /^all(\s|$)/i.test(rest)) { sub = 'all'; s = { args: [['role', 'role', true]] }; rest = rest.replace(/^all\s*/i, ''); }
    const usage = sub === 'all' ? `${prefix}role all <role>` : usageOf(prefix, name, sub, s);
    const resolveUser = async (id) => {
      const u = msg.mentions?.users?.get?.(id) ?? await msg.client?.users?.fetch?.(id).catch(() => null);
      if (!u) throw new UserError('I could not find that user.');
      return u;
    };
    const resolveRole = async (id) => {
      const r = msg.mentions?.roles?.get?.(id) ?? msg.guild.roles?.cache?.get?.(id) ?? await msg.guild.roles?.fetch?.(id).catch(() => null);
      if (!r) throw new UserError('I could not find that role.');
      return r;
    };
    const vals = await parseArgs(rest, s.args, { usage, resolveUser, resolveRole });
    if (name === 'steal') { const ref = msg.reference?.messageId ? await msg.fetchReference?.().catch(() => null) : null; vals.emoji = `${vals.emoji ?? ''} ${ref?.content ?? ''}`.trim(); }
    const att = msg.attachments?.first?.();
    if (name === 'ticket') { if (vals.text.length < 10) throw new UserError('Describe your problem in at least 10 characters.'); vals.subject = vals.text.slice(0, 80); vals.details = vals.text; }
    const i = interactionFrom(msg, name, optionsOf(sub, vals, att), { dm: !!s.dm });
    if (s.dm) msg.delete().catch(() => {});
    await route(i, ctx);
  } catch (e) {
    if (e instanceof UserError) await err(e.message);
    else { log.error('text command failed', e); await err('Something went wrong on our side.'); }
  }
  return true;
}
