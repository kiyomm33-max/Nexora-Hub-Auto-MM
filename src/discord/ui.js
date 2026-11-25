import { AttachmentBuilder, MediaGalleryBuilder, UserSelectMenuBuilder, ContainerBuilder, SectionBuilder, ThumbnailBuilder, TextDisplayBuilder, SeparatorBuilder, StringSelectMenuBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { fileURLToPath } from 'node:url';
import { usdWorth } from '../core/fees.js';
import { STATUS } from '../core/deals.js';
import { LABELS } from '../core/permissions.js';

const BLUE = 0x5865f2; // same blue as the primary buttons
export const BRAND = { name: 'Nexora Hub', blue: BLUE, purple: BLUE, deep: BLUE, black: 0x0b0b0f, white: 0xffffff, red: BLUE, green: BLUE, danger: 0xc0264b };
const STATUS_COLOR = { waiting_parties: BLUE, awaiting_provider: BLUE, verification_pending: BLUE, disputed: BRAND.danger, completed: BLUE, cancelled: BLUE };
const STATUS_MARK = { waiting_parties: '◌', awaiting_provider: '◔', verification_pending: '◑', disputed: '▲', completed: '●', cancelled: '✕' };

export const brand = (e, cfg) => {
  if (cfg?.brandLogo) e.setThumbnail(cfg.brandLogo);
  return e;
};
export const base = (cfg, title, desc, color = BRAND.purple) => brand(new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc ?? null), cfg);
export const errorEmbed = (cfg, msg) => base(cfg, 'Action not completed', msg, BRAND.red);
export const okEmbed = (cfg, title, msg) => base(cfg, title, msg);

const ts = (iso) => (iso ? `<t:${Math.floor(Date.parse(iso) / 1000)}:f>` : '—');
const modeBanner = (d) => (d.mode === 'demo' ? '**DEMO MODE** — simulated escrow. No real funds are held, moved or released.\n' : '');

export function escrowLines(d) {
  const obs = { none: 'No payment observed', seen: `Payment seen on-chain (${d.confirmations} conf.)`, confirmed_on_chain: `Confirmed on-chain (${d.confirmations} conf.)` }[d.observed_status];
  const esc = d.escrow_status === 'provider_confirmed'
    ? `Funds confirmed by provider${d.mode === 'demo' ? ' (SIMULATED)' : ''}`
    : d.escrow_status === 'pending' ? 'Not yet confirmed by provider' : 'No escrow';
  return { obs: `${obs}\n*Blockchain observation only — not escrow confirmation.*`, esc: `${esc}${d.escrow_status !== 'provider_confirmed' ? '\n**Funds are NOT confirmed as secured.**' : ''}` };
}

const shortTx = (h) => (h.length > 16 ? `${h.slice(0, 6)}…${h.slice(-8)}` : h);
/** `info` = { txid, url, amount } from the provider when a real payout happened. */
export function completedEmbed(cfg, d, names, info, { test = false } = {}) {
  const coin = Object.values(COINS).find((c) => c.asset === d.asset && c.network === d.network);
  const coinLabel = (coin?.label ?? d.asset).replace(/ \[.*\]/, '');
  const usd = Number(d.receive_usd || d.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sent = info?.amount ? `${info.amount} ${d.asset}` : d.asset;
  const lines = [
    '## <:checkmark:1575069601312808970> Funds Released',
    '*Nexora Auto MM - paid out to the receiver*', '',
    test ? '**Test post. The data below is a sample, not a real deal.**' : d.mode === 'demo' ? '**DEMO deal** - simulated, no real funds.' : null,
    test || d.mode === 'demo' ? '' : null,
    '**Deal Summary**',
    `> <:bluestar:1575122626307948614> **Sender** - ${names.sender ?? names.a}`, `> <:bluediamond:1575122581525237841> **Receiver** - ${names.receiver ?? names.b}`, names.middleman ? `> **Middleman** - ${names.middleman}` : null, `> <:tasks:1575100811950821467> **Deal ID** - \`${d.id}\``, '',
    '**Value**', `> <:Simbol_de_dolar_blau_neo_metalli:1575122530015125585> **USD Amount** - \`$${usd}\``, `> <:download:1575100863473782855> **Crypto Sent** - **${sent}** (${coinLabel})`,
    info?.txid ? '' : null, info?.txid ? '**Blockchain Proof**' : null, info?.txid ? `\`${shortTx(info.txid)}\`` : null, '',
    '*Want your name shown or hidden here? Use* `/set-privacy`',
  ].filter((x) => x !== null).join('\n');
  return base(cfg, null, lines, BLUE).setTitle(null);
}

export function vouchEmbed(cfg, { dealId, author, target, rating, text, createdAt }) {
  return base(cfg, 'Verified Vouch', `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}  (${rating}/5)\n\n>>> ${text}`)
    .addFields(
      { name: 'From', value: author, inline: true }, { name: 'For', value: target, inline: true },
      { name: 'Deal', value: `\`${dealId}\` — Verified completed deal`, inline: true }, { name: 'Date', value: ts(createdAt), inline: true });
}

export function historyEmbed(cfg, dealId, rows) {
  const lines = rows.slice(-20).map((r) => `${ts(r.ts)} \`${r.action}\` ${/^\d+$/.test(r.actor) ? `<@${r.actor}>` : `\`${r.actor}\``}`);
  return base(cfg, `History  •  ${dealId}`, lines.join('\n') || 'No entries.').setFooter({ text: `Nexora Hub  •  append-only audit log  •  ${rows.length} entries` });
}

const btn = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const row = (...b) => new ActionRowBuilder().addComponents(...b);

const input = (id, label, { style = TextInputStyle.Short, required = true, max = 200, min = 1, placeholder } = {}) =>
  row(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max).setMinLength(required ? min : 0).setPlaceholder(placeholder ?? ''));
export const modal = (id, title, ...rows) => new ModalBuilder().setCustomId(id).setTitle(title).addComponents(...rows);

export const disputeModal = (dealId = '') => modal(`nx:disputemodal:${dealId || 'ask'}`, 'Open a dispute',
  ...(dealId ? [] : [input('deal_id', 'Deal ID', { max: 12, min: 12, placeholder: 'NXH-AB12CD34' })]),
  input('reason', 'What went wrong?', { style: TextInputStyle.Paragraph, max: 1000, min: 10 }));
export const evidenceModal = (dealId) => modal(`nx:evidencemodal:${dealId}`, 'Submit evidence',
  input('note', 'Describe this evidence', { style: TextInputStyle.Paragraph, max: 1000, min: 5 }),
  input('url', 'Link (https, optional)', { required: false, max: 500 }));
export const ticketModal = () => modal('nx:ticketmodal', 'Support ticket',
  input('subject', 'Subject', { max: 80, min: 3 }), input('details', 'How can we help?', { style: TextInputStyle.Paragraph, max: 1000, min: 10 }));
export const vouchModal = (dealId) => modal(`nx:vouchmodal:${dealId}`, 'Leave a vouch',
  input('rating', 'Rating (1-5)', { max: 1, min: 1 }), input('text', 'Feedback', { style: TextInputStyle.Paragraph, max: 500, min: 5 }));
export const staffLabel = (r) => LABELS[r] ?? 'Member';
export const statusText = (s) => `${STATUS_MARK[s]} ${STATUS[s]}`;

// ---------------- auto-MM UI ----------------
const FEE_LABEL = { sender: 'Sender pays the fee', receiver: 'Receiver pays the fee', split: 'Split 50/50' };
export const COINS = {
  BTC: { label: 'Bitcoin', mark: '₿', asset: 'BTC', network: 'bitcoin' },
  ETH: { label: 'Ethereum', mark: 'Ξ', asset: 'ETH', network: 'ethereum' },
  LTC: { label: 'Litecoin', mark: 'Ł', asset: 'LTC', network: 'litecoin' },
  SOL: { label: 'Solana', mark: '◎', asset: 'SOL', network: 'solana' },
  'USDT-ERC20': { label: 'USDT [ERC-20]', mark: '₮', asset: 'USDT', network: 'ethereum' },
  'USDC-ERC20': { label: 'USDC [ERC-20]', mark: '$', asset: 'USDC', network: 'ethereum' },
  'USDT-BEP20': { label: 'USDT [BEP-20]', mark: '₮', asset: 'USDT', network: 'bsc' },
};
export const coinName = (d) => Object.values(COINS).find((c) => c.asset === d.asset && c.network === d.network)?.label ?? `${d.asset} (${d.network})`;
const text = (t) => new TextDisplayBuilder().setContent(t);
import { emojiMap } from './emojis.js';
export const coinIcon = (c) => emojiMap.get(c.asset) ?? c.mark;
const section = (t, key) => new SectionBuilder().addTextDisplayComponents(text(t))
  .setButtonAccessory(new ButtonBuilder().setCustomId(`nx:am-start:${key}`).setLabel('Start').setStyle(ButtonStyle.Primary));

const NETS = { bitcoin: 'Bitcoin', ethereum: 'Ethereum', litecoin: 'Litecoin', solana: 'Solana', bsc: 'BNB Smart Chain' };
const emojiOf = (c) => { const m = /^<(a?):(\w+):(\d+)>$/.exec(emojiMap.get(c.asset) ?? ''); return m ? { id: m[3], name: m[2], animated: !!m[1] } : null; };

/** Components V2 panel: one dropdown with every coin. Picking one opens a private deal room. */
export function panelPayload(cfg, mode) {
  const on = (keys) => (mode === 'live' ? keys.filter((k) => cfg.coins?.enabled?.includes(k)) : keys);
  const keys = on(['ETH', 'LTC', 'SOL', 'USDT-ERC20', 'USDC-ERC20', 'USDT-BEP20']);
  const demo = mode === 'demo' ? '\n**DEMO MODE** - simulated escrow, no real funds.' : '';
  const rules = cfg.channels?.rules ? `<#${cfg.channels.rules}>` : 'the rules channel';
  const menu = new StringSelectMenuBuilder().setCustomId('nx:am-pick').setPlaceholder('Select a coin to start a deal').addOptions(keys.map((k) => {
    const c = COINS[k]; const o = { label: `${c.asset} | ${NETS[c.network] ?? c.label}`, value: k, description: `Open a protected ${c.asset} deal on ${NETS[c.network] ?? c.label}` };
    const em = emojiOf(c); if (em) o.emoji = em; return o;
  }));
  const c = new ContainerBuilder().setAccentColor(BRAND.purple)
    .addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(`## <:aaaaaaaa:1575247365198061638> Nexora Auto MM\nAutomated crypto escrow\nPlease read ${rules} before you start.${demo}`))
      .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: 'https://cdn.discordapp.com/emojis/1575208406531444906.png?size=128' } })))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text('<:add:1575069932130140220> **Add the other side of the deal**\n<:aaaaaaaaaaaaa:1575248196471492618> **Agree on the item, terms and price**\n<:959d67ae71c14b229c46f416110461ab:1575197569808728104> **Fund the escrow and release when ready**'))
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(new ActionRowBuilder().addComponents(menu))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text('**Opens a private deal room where the payment is held until both sides approve the outcome.**'));
  return { flags: 1 << 15, components: [c] };
}
const usdFmt = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const trustBar = (p) => { const n = Math.round(p * 10); return `${'▰'.repeat(n)}${'▱'.repeat(10 - n)}`; };
export const trustEmbed = (name, avatarUrl, t) => {
  const e = new EmbedBuilder().setColor(BLUE).setTitle('Nexora Hub Trust Profile').setAuthor({ name, iconURL: avatarUrl ?? undefined }).setThumbnail(avatarUrl ?? null);
  const head = `## ${t.tier.emoji} ${t.tier.name} Tier`;
  const prog = t.max ? `**MAX TIER**\n${trustBar(1)} **100%**\nYou reached the highest trust tier. ${t.tier.emoji}`
    : `${trustBar(t.progress)} **${Math.round(t.progress * 100)}%**\n**${usdFmt(t.remaining)}** to reach ${t.next.emoji} **${t.next.name}** (${usdFmt(t.next.min)}+)`;
  return e.setDescription(`${head}\n${t.trades ? '' : '*No completed trades yet. Everyone starts on Pluto.*\n'}\n**Verified volume:** **${usdFmt(t.volume)}**\n**Completed trades:** **${t.trades}**\n\n**Progress**\n${prog}`);
};
export const statsEmbed = (name, avatarUrl, st) => new EmbedBuilder().setColor(BLUE)
  .setTitle(`${name} - Tier ${st.tier}`)
  .setDescription(`Global rank ${st.rank ? `\`#${st.rank}\`` : '`unranked`'} - ${st.next == null ? 'Max tier reached' : `Next tier in \`${usdFmt(st.next)}\``}\n\n## Deal Stats\n- **Completed:** ${st.completed}\n- **Total Dealt:** ${usdFmt(st.total)}\n- **Largest Deal:** ${usdFmt(st.largest)}\n- **Completion Rate:** ${st.rate}%`)
  .setThumbnail(avatarUrl ?? null);

/** Components V2 support panel: one button that opens the ticket form. */
export function supportPanelPayload() {
  const c = new ContainerBuilder().setAccentColor(BRAND.purple)
    .addTextDisplayComponents(text('## Nexora Hub Support\nIf anything goes wrong, **open a support ticket** and our staff will help you. Your ticket is **private**: only you and the admins can see it.\n\n**Never** share passwords, 2FA codes or seed phrases. Staff will never ask for them.'))
    .addSeparatorComponents(new SeparatorBuilder())
    .addSectionComponents(new SectionBuilder().addTextDisplayComponents(text('**Need help?** Describe the problem and we will take it from there.'))
      .setButtonAccessory(new ButtonBuilder().setCustomId('nx:ticket-start').setLabel('Open Ticket').setStyle(ButtonStyle.Primary)));
  return { flags: 1 << 15, components: [c] };
}
// Icons of the deal card: custom emojis from the Nexora server. Change an ID here to swap one.
export const CARD_ICONS = { title: '<:add:1575069932130140220>', sender: '<:bluestar:1575122626307948614>', receiver: '<:bluediamond:1575122581525237841>', instruction: '<:tasks:1575100811950821467>', amount: '<:Simbol_de_dolar_blau_neo_metalli:1575122530015125585>', thumb: 'https://cdn.discordapp.com/emojis/1575069932130140220.png?size=128' };
const STEP_STAGE = { type: 1, partner: 1, roles: 2, describe: 3, accept: 3, amount: 3, amount_confirm: 3, fee: 3, fee_confirm: 3 };
const STEP_TEXT = {
  type: 'The opener must invite the other party.', partner: 'The opener must invite the other party.', roles: 'Both traders must pick a role: Sender or Receiver.',
  describe: 'A trader must write the deal details.', accept: 'The other trader must accept the deal description.', amount: 'State the deal amount in USD.',
  amount_confirm: 'Both traders must confirm the amount.', fee: 'The sender must choose who pays the fee.', fee_confirm: 'The receiver must confirm the fee choice.',
};
const PHASE_TEXT = {
  invoice: 'The sender must send the exact amount to the address in the invoice.', detected: 'Payment detected. Waiting for confirmations.',
  short: 'The payment is less than the deal amount. Both traders must decide.', received: 'Payment confirmed. The sender presses Release once the trade is delivered.',
  payout: 'The receiver must send their payout address.', paying: 'Sending the payout to the receiver.', completed: 'Funds released. This deal is complete.',
  cancelled: 'This deal was cancelled.', disputed: 'This deal is disputed and under staff review.',
};
const STAGE_LABEL = ['Waiting for counterparty', 'Choosing roles', 'Agreeing on the deal', 'Waiting for payment', 'Release'];
/** Where the deal is, 1 to 5, and what the traders have to do next. */
export function dealProgress(d, set) {
  if (d.status === 'waiting_parties') { const step = set?.step ?? 'partner'; return { stage: STEP_STAGE[step] ?? 1, label: STAGE_LABEL[(STEP_STAGE[step] ?? 1) - 1], instruction: STEP_TEXT[step] ?? STEP_TEXT.partner }; }
  const ph = phaseOf(d); const stage = ['invoice', 'detected', 'short'].includes(ph) ? 4 : 5;
  const label = d.status === 'completed' ? 'Completed' : d.status === 'cancelled' ? 'Cancelled' : d.status === 'disputed' ? 'Disputed' : STAGE_LABEL[stage - 1];
  return { stage, label, instruction: PHASE_TEXT[ph] ?? PHASE_TEXT.received };
}
export const lineFile = () => new AttachmentBuilder(fileURLToPath(new URL('../../assets/line.png', import.meta.url)), { name: 'line.png' });
/** The live card at the top of a deal room. It is edited in place as the deal moves. */
export function dealCard(cfg, d, set) {
  const { stage, label, instruction } = dealProgress(d, set);
  const coin = Object.values(COINS).find((c) => c.asset === d.asset && c.network === d.network);
  const dots = [1, 2, 3, 4, 5].map((n) => (n <= stage ? '●' : '○')).join(' ');
  const who = (id) => (id ? `<@${id}>` : 'not assigned');
  const lines = [
    `## ${CARD_ICONS.title} Deal \`${d.id}\``,
    `**Hello <@${d.party_a}>, welcome to Nexora Hub.**`, '',
    `**${label}:** | ${dots} Stage ${stage}/5`,
  ].join('\n');
  const info = [
    `${coin ? coinIcon(coin) : ''} **Asset:** ${coin?.label ?? `${d.asset} on ${d.network}`}`,
    `${CARD_ICONS.sender} **Sender:** ${who(d.sender_id)}`,
    `${CARD_ICONS.receiver} **Receiver:** ${who(d.receiver_id)}`,
    d.amount ? `${CARD_ICONS.amount} **Amount:** \`$${Number(d.amount).toFixed(2)}\`` : null,
  ].filter(Boolean).join('\n');
  const c = new ContainerBuilder().setAccentColor(d.status === 'disputed' ? BRAND.danger : BLUE)
    .addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(lines)).setThumbnailAccessory(new ThumbnailBuilder({ media: { url: CARD_ICONS.thumb } })))
    .addSeparatorComponents(new SeparatorBuilder()).addTextDisplayComponents(text(info))
    .addSeparatorComponents(new SeparatorBuilder()).addTextDisplayComponents(text(`## ${CARD_ICONS.instruction} Current instruction\n${instruction}${d.mode === 'demo' ? '\n**DEMO MODE** - simulated escrow, no real funds.' : ''}`))
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems({ media: { url: 'attachment://line.png' } }))
    .addTextDisplayComponents(text(`**Opened** <t:${Math.floor(Date.parse(d.created_at) / 1000)}:R>`));
  return { flags: 1 << 15, components: [c], allowedMentions: { parse: [] } };
}

const votesText = (d, set) => Object.entries(set.votes ?? {}).map(([u, v]) => `<@${u}>: **${v}**`).join('\n') || 'No answers yet.';
const parties = (d) => `<@${d.party_a}>${d.party_b ? ` and <@${d.party_b}>` : ''}`;

/** The step shown while a deal is still being set up (status: waiting_parties). */
export function stepPayload(cfg, d, set) {
  const step = set.step;
  const e = (t, desc) => base(cfg, t, desc);
  switch (step) {
    case 'type': // legacy rooms created before the Deal Type step was removed: skip straight to adding the trader
    case 'partner': {
      const lines = cfg.messageContent
        ? `**Two ways to add them:**\n- Click **Invite Other Party** and paste their Discord ID\n- Mention them directly in this channel`
        : `**How to add them:**\n- Click **Invite Other Party** and paste their Discord ID`;
      const box = new ContainerBuilder().setAccentColor(BLUE)
        .addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(`## ${CARD_ICONS.title} Add the other party\nChoose who you are dealing with, <@${d.party_a}>.`))
          .setButtonAccessory(btn(`nx:am-partnerid:${d.id}`, 'Invite Other Party', ButtonStyle.Primary).setEmoji(CARD_ICONS.title.match(/:(\d+)>/)[1])))
        .addSeparatorComponents(new SeparatorBuilder()).addTextDisplayComponents(text(lines))
        .addSeparatorComponents(new SeparatorBuilder())
        .addActionRowComponents(row(btn(`nx:am-close:${d.id}`, 'Cancel Deal', ButtonStyle.Danger).setEmoji('1575259368771948705')))
        .addMediaGalleryComponents(new MediaGalleryBuilder().addItems({ media: { url: 'attachment://line.png' } }));
      return { flags: 1 << 15, components: [box], files: [lineFile()] };
    }
    case 'roles': {
      const who = (r) => { const u = Object.keys(set.votes ?? {}).find((x) => set.votes[x] === r); return u ? `<@${u}>` : 'None'; };
      const SENDER = '<:Sender:1575262944063787161>', RECEIVER = '<:download:1575100863473782855>';
      const id = (m) => m.match(/:(\d+)>/)[1];
      const pick = (icon, label, line, r, cta) => new SectionBuilder()
        .addTextDisplayComponents(text(`### ${icon} ${label}: ${who(r)}\n${line}`))
        .setButtonAccessory(btn(`nx:am-role:${d.id}:${r}`, cta, ButtonStyle.Primary).setEmoji(id(icon)));
      const box = new ContainerBuilder().setAccentColor(BLUE)
        .addSectionComponents(new SectionBuilder()
          .addTextDisplayComponents(text(`## <:aaaaaaaa:1575247365198061638> Who is sending and receiving?\nChoose your own role. The other party must choose the opposite role before the deal can continue.`))
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(`https://cdn.discordapp.com/emojis/1575248196471492618.png?size=128`)))
        .addSeparatorComponents(new SeparatorBuilder())
        .addSectionComponents(pick(SENDER, 'Sender', `Sends ${coinName(d)} into the escrow wallet.`, 'sender', "I'm sending"))
        .addSeparatorComponents(new SeparatorBuilder())
        .addSectionComponents(pick(RECEIVER, 'Receiver', 'Receives the payout once the deal is released.', 'receiver', "I'm receiving"))
        .addSeparatorComponents(new SeparatorBuilder())
        .addActionRowComponents(row(btn(`nx:am-rolereset:${d.id}`, 'Reset', ButtonStyle.Secondary), btn(`nx:am-close:${d.id}`, 'Cancel Deal', ButtonStyle.Danger).setEmoji('1575259368771948705')))
        .addMediaGalleryComponents(new MediaGalleryBuilder().addItems({ media: { url: 'attachment://line.png' } }));
      return { flags: 1 << 15, components: [text(`${parties(d)} Welcome! Select roles below.`), box], files: [lineFile()] };
    }
    case 'describe': return { embeds: [e('Deal Details', `Before continuing, please write out **all deal details** such as usernames, amounts, and items being traded.\n\n**Sender:** <@${d.sender_id}>  **Receiver:** <@${d.receiver_id}>\n\n**Ex.** \`Brief summary of who sends what to whom\`\nThe other trader will then be asked to accept it.`)],
      components: [row(btn(`nx:am-describe:${d.id}`, 'Write deal details', ButtonStyle.Primary))] };
    case 'accept': return { embeds: [e('Accept the deal description', `**Description** by <@${d.desc_by}>:\n>>> ${d.item}\n\n<@${d.desc_by === d.party_a ? d.party_b : d.party_a}>, do you accept this description?`)],
      components: [row(btn(`nx:am-accept:${d.id}`, 'Accept', ButtonStyle.Success), btn(`nx:am-decline:${d.id}`, 'Decline', ButtonStyle.Danger))] };
    case 'amount': return { embeds: [e('Deal Amount', 'State the **amount in USD** the bot is expected to receive (eg. 100.59)\n\n**Ticket will be closed in 30 minutes if left unattended**')],
      components: [row(btn(`nx:am-amount:${d.id}`, 'Enter amount', ButtonStyle.Primary))] };
    case 'amount_confirm': return { embeds: [e('Amount Confirmation', `**Both users** must confirm the USD deal amount\n\n**Amount:** \`$${d.amount}\`\n\n${votesText(d, set)}`)],
      components: [row(btn(`nx:am-amtok:${d.id}`, 'Correct', ButtonStyle.Success), btn(`nx:am-amtno:${d.id}`, 'Incorrect', ButtonStyle.Secondary))] };
    case 'fee': {
      const box = new ContainerBuilder().setAccentColor(BLUE)
        .addTextDisplayComponents(text('## Service Fee Selection\nOnly the **sender** can choose how the middleman service fee will be handled for this deal. The receiver will confirm the selection.\n\nThe selected option will be applied after the deal is completed.'))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(text(`**Fee:**\n\`$${Number(d.fee_usd).toFixed(2)}\``));
      return { flags: 1 << 15, components: [text(`<@${d.sender_id}>, choose who pays the fee.`), box,
        row(btn(`nx:am-fee:${d.id}:sender`, 'Sender', ButtonStyle.Secondary), btn(`nx:am-fee:${d.id}:receiver`, 'Receiver', ButtonStyle.Secondary), btn(`nx:am-fee:${d.id}:split`, 'Split', ButtonStyle.Success))] };
    }
    case 'fee_confirm': return { embeds: [e('Confirm the service fee', `<@${d.sender_id}> chose: **${FEE_LABEL[set.pending] ?? set.pending}**\n\n**Fee:** \`$${Number(d.fee_usd).toFixed(2)}\`\n\n<@${d.receiver_id}>, do you agree?`)],
      components: [row(btn(`nx:am-feeok:${d.id}`, 'Agree', ButtonStyle.Success), btn(`nx:am-feeno:${d.id}`, 'Disagree', ButtonStyle.Secondary))] };
    default: return { embeds: [e('Deal', 'Setting up…')], components: [] };
  }
}

export function dealEmbed(cfg, d) {
  const { obs, esc } = escrowLines(d);
  const received = d.status === 'verification_pending' && d.escrow_status === 'provider_confirmed';
  const title = { waiting_parties: 'Deal setup', awaiting_provider: 'Awaiting payment', verification_pending: received ? 'Payment received' : 'Waiting for confirmations', disputed: 'Disputed', completed: 'Deal completed', cancelled: 'Deal cancelled' }[d.status];
  const e = base(cfg, `${title}  •  ${d.id}`, `${modeBanner(d)}${STATUS_MARK[d.status]}  **${STATUS[d.status]}**`, STATUS_COLOR[d.status]);
  e.addFields(
    { name: 'Sender', value: d.sender_id ? `<@${d.sender_id}>` : '—', inline: true },
    { name: 'Receiver', value: d.receiver_id ? `<@${d.receiver_id}>` : '—', inline: true },
    { name: 'Middleman', value: d.middleman_id ? `<@${d.middleman_id}>` : 'Not yet claimed', inline: true },
    { name: 'Deal', value: d.item || '—' },
    { name: 'Crypto', value: coinName(d), inline: true },
    { name: 'Amount', value: `$${d.amount} USD`, inline: true },
    { name: 'Fee', value: Number(d.fee_usd) ? `$${d.fee_usd} — ${FEE_LABEL[d.fee_payer] ?? 'not chosen'}` : 'None', inline: true },
  );
  if (d.send_usd) e.addFields({ name: 'Sender sends', value: `**$${d.send_usd} USD** worth of ${d.asset}`, inline: true }, { name: 'Receiver gets', value: `**$${d.receive_usd} USD** worth of ${d.asset}`, inline: true });
  if (d.status === 'awaiting_provider' || (d.status === 'verification_pending' && !received)) {
    e.addFields({ name: 'Send payment to', value: `\`${d.pay_address}\`\n${d.mode === 'demo' ? '**DEMO address — NOT a real address. Do not send real funds.**' : 'Address issued by the escrow provider. Verify the network is ' + d.network + '.'}\nThe exact crypto amount is quoted by the provider for the USD total above.` });
  }
  if (d.status !== 'waiting_parties') e.addFields({ name: 'Escrow (provider)', value: `${esc}\nProvider: ${d.provider ?? '—'}`, inline: true }, { name: 'On-chain observation', value: obs, inline: true });
  if (received) e.addFields({ name: 'Next step', value: `The provider confirmed the payment. Once the trade is delivered, <@${d.sender_id}> presses **Release** to send it to <@${d.receiver_id}>.` });
  if (d.release_at && ['verification_pending'].includes(d.status)) e.addFields({ name: 'Release scheduled', value: `Releasing <t:${Math.floor(Date.parse(d.release_at) / 1000)}:R> (started by <@${d.release_by}>). The releaser can cancel before the timer ends.` });
  if (d.provider_ref) e.addFields({ name: 'Provider reference', value: `\`${d.provider_ref}\`` });
  e.addFields({ name: 'Timeline', value: `Created ${ts(d.created_at)}\nConfirmed ${ts(d.confirmed_at)}${d.disputed_at ? `\nDisputed ${ts(d.disputed_at)}` : ''}${d.completed_at ? `\nCompleted ${ts(d.completed_at)}` : ''}${d.cancelled_at ? `\nCancelled ${ts(d.cancelled_at)}` : ''}` });
  if (d.status === 'disputed') e.addFields({ name: 'Dispute', value: 'Referred to the external escrow provider. Staff review evidence but **never release disputed funds themselves**.' });
  return e;
}

const usd = (n) => `$${Number(n).toFixed(2)}`;
const txLink = (h) => (h ? `\`${h.length > 20 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h}\`` : '—');
export const phaseOf = (d) => {
  if (d.status === 'awaiting_provider') return 'invoice';
  if (d.status === 'verification_pending') {
    if (d.released_at) return d.payout_address ? 'paying' : 'payout';
    if (d.short_state === 'pending' && d.escrow_status !== 'provider_confirmed') return 'short';
    return d.escrow_status === 'provider_confirmed' ? 'received' : 'detected';
  }
  return d.status;
};

export function summaryEmbed(cfg, d) {
  const e = base(cfg, 'Deal Summary', `Refer to this deal summary for any reaffirmations. Notify staff for any support required.${d.mode === 'demo' ? '\n**DEMO MODE** — simulated escrow, no real funds.' : ''}`)
    .addFields({ name: 'Sender', value: `<@${d.sender_id}>` }, { name: 'Receiver', value: `<@${d.receiver_id}>` }, { name: 'Coin', value: coinName(d) },
      { name: 'Deal Amount', value: `\`${usd(d.amount)}\`` });
  if (Number(d.fee_usd)) e.addFields({ name: 'Fee', value: `\`${usd(d.fee_usd)}\` — ${FEE_LABEL[d.fee_payer]}\nSender sends \`${usd(d.send_usd)}\`, receiver gets \`${usd(d.receive_usd)}\`` });
  return e.addFields({ name: 'Deal', value: d.item });
}
export function invoiceEmbed(cfg, d) {
  const demo = d.mode === 'demo';
  const e = base(cfg, 'Payment Invoice', `<@${d.sender_id}> **Send the funds** to the escrow address below. Please copy the **exact amount** provided.${demo ? '\n**DEMO — this address is NOT real. Do not send real funds.**' : ''}`)
    .addFields({ name: 'Address', value: `\`${d.pay_address}\`` },
      { name: 'Amount', value: `\`${d.pay_amount}\` ${d.asset} (${usd(d.send_usd)} USD)\nExchange Rate: 1 ${d.asset} = ${d.rate_usd} USD${demo ? ' (DEMO rate)' : ''}` },
      { name: 'Network', value: d.network, inline: true });
  return e;
}
export function shortEmbed(cfg, d) {
  const got = usdWorth(d, d.short_crypto);
  return base(cfg, 'Warning: payment is less than the deal amount', `<@${d.sender_id}> only sent **${usd(got)} USD** (\`${d.short_crypto}\` ${d.asset}), but the deal needs **${usd(d.send_usd)} USD**.\n\n**Do you still want to continue** with the smaller amount? **Both traders must agree** (press Continue). Or the **sender** can **cancel** and get exactly what they sent back.\n*If you send the rest to the same address, it is added automatically.*`, BRAND.red)
    .addFields({ name: 'Needed', value: `\`${d.pay_amount}\` ${d.asset} (${usd(d.send_usd)} USD)`, inline: true }, { name: 'Received', value: `\`${d.short_crypto}\` ${d.asset} (${usd(got)} USD)`, inline: true },
      { name: 'Transaction', value: txLink(d.tx_hash) });
}
export function detectedEmbed(cfg, d) {
  return base(cfg, 'Transaction Detected', 'Your payment has been **detected** on the network.\nPlease wait while it receives the **required confirmations**.\n*Blockchain observation only — not escrow confirmation.*', BLUE)
    .addFields({ name: 'Transaction', value: txLink(d.tx_hash) }, { name: 'Amount Received', value: d.received_crypto ? `\`${d.received_crypto}\` ${d.asset} ≈ ${usd(usdWorth(d, d.received_crypto))} USD` : 'Pending' },
      { name: 'Required Confirmations', value: `\`${d.required_conf}\` (seen: \`${d.confirmations}\`)` });
}
export function receivedEmbeds(cfg, d) {
  return [
    base(cfg, 'Payment Received', 'The payment is now **secured** and has reached the **required confirmations**.', BLUE)
      .addFields({ name: 'Transaction', value: txLink(d.tx_hash) }, { name: 'Confirmations', value: `\`${d.confirmations}\`` }, { name: 'Amount Received', value: `\`${d.received_crypto ?? d.pay_amount}\` ${d.asset} (${usd(d.send_usd)} USD)` }),
    base(cfg, 'You may now proceed with the deal', `The receiver (<@${d.receiver_id}>) may now provide the goods to the sender (<@${d.sender_id}>).\n\nOnce the deal is complete, the sender must click the **Release** button below to release the funds to the receiver and complete the deal.${d.release_at ? `\n\n**Release countdown:** <t:${Math.floor(Date.parse(d.release_at) / 1000)}:R> — <@${d.release_by}> can cancel before it ends.` : ''}`),
  ];
}
export const payoutEmbed = (cfg, d) => base(cfg, `Send your ${coinName(d).replace(/ \[.*\]/, '')} (${d.asset}) address`, `<@${d.receiver_id}> the sender **released the payment**.\n**Send your ${d.asset} (${d.network}) address in this channel** as a message. You will be asked to confirm it before the payout starts.\nDouble-check it: **payouts cannot be reversed**.`);

/** Everything the single status message shows for the current phase. */
export function statusEmbeds(cfg, d) {
  switch (phaseOf(d)) {
    case 'invoice': return [summaryEmbed(cfg, d), invoiceEmbed(cfg, d)];
    case 'short': return [shortEmbed(cfg, d)];
    case 'detected': return [detectedEmbed(cfg, d)];
    case 'received': return receivedEmbeds(cfg, d);
    case 'payout': return [payoutEmbed(cfg, d)];
    case 'paying': return [base(cfg, 'Payout requested', `The provider is processing the payout to \`${d.payout_address}\`.`)];
    default: return [dealEmbed(cfg, d)];
  }
}

export function roomButtons(d, cfg) {
  const phase = phaseOf(d);
  const rows = [];
  if (phase === 'short') return [row(btn(`nx:am-shortyes:${d.id}`, `Continue with ${usd(usdWorth(d, d.short_crypto))}`, ButtonStyle.Primary), btn(`nx:am-shortno:${d.id}`, 'Cancel & refund', ButtonStyle.Danger))];
  if (phase === 'received') return [row(btn(`nx:am-release:${d.id}`, 'Release', ButtonStyle.Primary).setDisabled(!!d.release_at), btn(`nx:am-cancelask:${d.id}`, 'Cancel & refund').setDisabled(!!d.release_at))];
  // The receiver normally just types their address in the room; the button is only a fallback when the bot cannot read messages.
  if (phase === 'payout') { if (!cfg?.messageContent) rows.push(row(btn(`nx:am-payaddr:${d.id}`, 'Provide address', ButtonStyle.Primary))); return rows; }
  if (phase === 'paying') return rows;
  const last = [];
  if (d.status === 'completed') last.push(btn(`nx:vouch:${d.id}`, 'Leave a vouch', ButtonStyle.Primary));
  last.push(btn(`nx:am-close:${d.id}`, ['completed', 'cancelled'].includes(d.status) ? 'Save transcript & close' : 'Close'));
  rows.push(row(...last));
  return rows;
}
export const partnerIdModal = (id) => modal(`nx:am-partnermodal:${id}`, 'Add the other trader', input('uid', 'Discord user ID', { min: 15, max: 25, placeholder: '123456789012345678' }));
export const descModal = (id) => modal(`nx:am-descmodal:${id}`, 'Describe the deal', input('desc', 'What is being exchanged?', { style: TextInputStyle.Paragraph, min: 5, max: 300, placeholder: 'e.g. 20k Robux for $20 of LTC' }));
export const amountModal = (id) => modal(`nx:am-amountmodal:${id}`, 'Deal amount', input('amount', 'Amount in USD', { min: 1, max: 12, placeholder: '20' }));
export const ticketButtons = (id) => [row(btn(`nx:tstaff:${id}`, 'Request staff'), btn(`nx:tclose:${id}`, 'Close & save transcript', ButtonStyle.Danger))];
export const payoutModal = (id, asset) => modal(`nx:am-payaddrmodal:${id}`, `Your ${asset} address`, input('addr', `${asset} address to receive the payout`, { min: 20, max: 100 }));

// ---------- activity: message leaderboard, server tag and status ----------
const num = (n) => Number(n).toLocaleString('en-US');
export function leaderboardEmbed(cfg, { period, label, rows, total, people, me, since }) {
  const lines = rows.map((r, k) => `**${k + 1}.** <@${r.user_id}> - **${num(r.n)}** messages`).join('\n') || 'No messages counted yet.';
  const mine = me && !rows.some((r) => r.user_id === me.id) ? `\n\nYour rank: **#${me.rank}** with **${num(me.n)}** messages` : '';
  return base(cfg, `Message Leaderboard - ${label}`, `${lines}${mine}\n\n**${num(total)}** messages from **${num(people)}** people${since ? `, counted since **${since}**` : ''}.`);
}
export function inviteBoardEmbed(cfg, { rows, people, total, me }) {
  const lines = rows.map((r, k) => `**${k + 1}.** <@${r.id}> - **${num(r.here)}** invite${r.here === 1 ? '' : 's'}${r.left ? ` (${num(r.left)} left)` : ''}`).join('\n') || 'No invites tracked yet.';
  const mine = me && !rows.some((r) => r.id === me.id) ? `\n\nYour rank: **#${me.rank}** with **${num(me.here)}** invite${me.here === 1 ? '' : 's'}` : '';
  return base(cfg, 'Invite Leaderboard', `${lines}${mine}\n\n**${num(total)}** members still here from **${num(people)}** inviters. Members who left are not counted.`);
}
export function messagesEmbed(cfg, name, avatarUrl, st) {
  const e = base(cfg, `${name} - Messages`, `Rank **${st.rank ? `#${st.rank}` : 'unranked'}**${st.since ? `, counted since **${st.since}**` : ''}`)
    .addFields({ name: 'Today', value: `\`${num(st.today)}\``, inline: true }, { name: 'Last 7 days', value: `\`${num(st.week)}\``, inline: true },
      { name: 'Last 30 days', value: `\`${num(st.month)}\``, inline: true }, { name: 'All time', value: `\`${num(st.all)}\``, inline: true });
  return avatarUrl ? e.setThumbnail(avatarUrl) : e;
}
const tstamp = (iso) => `<t:${Math.floor(Date.parse(iso) / 1000)}:f>`;
export function perkLines(sum, dur) {
  if (!sum.times) return 'Never seen.';
  return `${sum.active ? `**Active now**, since ${tstamp(sum.active)} (<t:${Math.floor(Date.parse(sum.active) / 1000)}:R>)` : `**Not active**${sum.last ? `, ended ${tstamp(sum.last)}` : ''}`}\nTimes: \`${sum.times}\`  Total time: \`${dur(sum.totalMs)}\`  Longest: \`${dur(sum.longestMs)}\`\nFirst seen: ${tstamp(sum.first)}`;
}
export function tagEmbed(cfg, who, tag, status, dur, phrase) {
  return base(cfg, 'Server tag and status', `<@${who}>`)
    .addFields({ name: 'Server tag', value: perkLines(tag, dur) }, { name: `Status with ${phrase}`, value: perkLines(status, dur) });
}
export function tagBoardEmbed(cfg, tag, status, dur, phrase) {
  const fmt = (b) => b.rows.map((r, k) => `**${k + 1}.** <@${r.user_id}> - \`${dur(r.totalMs)}\`, ${r.times}x${r.active ? ', **active**' : ''}`).join('\n') || 'Nobody yet.';
  return base(cfg, 'Server tag and status leaderboard', 'Ranked by total time. Times are counted from when the bot first saw it.')
    .addFields({ name: `Server tag - ${tag.activeNow} active now, ${tag.everyone} ever`, value: fmt(tag).slice(0, 1024) }, { name: `Status with ${phrase} - ${status.activeNow} active now, ${status.everyone} ever`, value: fmt(status).slice(0, 1024) });
}

// ---------------- status rewards ----------------
const cusd = (c) => `$${(c / 100).toFixed(2)}`;
const dur = (s) => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' '); };
export const statusPanelPayload = (cfg) => {
  const p = cfg.statusPay; const week = 7 * p.dailyCents + p.weekBonusCents;
  const c = new ContainerBuilder().setAccentColor(BRAND.purple)
    .addSectionComponents(new SectionBuilder().addTextDisplayComponents(text('## Status Rewards\nGet paid for your Discord status.'))
      .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: 'attachment://status.png' } })))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text(`**How it works**\n**1.** Copy this exact custom status:\n\`\`\`\nBest Auto MM - .${cfg.statusPhrase}\n\`\`\`\n**2.** Stay **Online** or **Do Not Disturb** and set the expiry to **Don't clear**.\n**3.** Press **Start Earning**. Your time adds up across sessions.\n**4.** Press **Request Payout**, choose a payment method and enter your details.`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text(`**Pay**\n**24 hours online:** ${cusd(p.dailyCents)}\n**7 days online:** +${cusd(p.weekBonusCents)} bonus\n**Full week:** ${cusd(week)} total`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text(`**Minimum payout:** ${cusd(p.minPayoutCents)}  |  PayPal, Litecoin, Solana or Ethereum\nPayouts are sent by staff by hand. Idle or offline time does not count.`))
    .addActionRowComponents(row(btn('nx:st-start', 'Start Earning', ButtonStyle.Primary), btn('nx:st-time', 'Online Time'), btn('nx:st-payout', 'Request Payout')));
  return { flags: 1 << 15, components: [c] };
};
export const earnTimeEmbed = (cfg, s) => base(cfg, 'Online Time', !s.enrolled ? 'You have not started yet. Press **Start Earning** on the panel.' :
  `**Status:** ${s.counting ? 'counting now' : 'not counting (status or presence is not matching)'}\n**Time online:** **${dur(s.seconds)}**\n**Earned:** **${cusd(s.earned)}**\n**Pending payout:** ${cusd(s.pending)}\n**Paid out:** ${cusd(s.paid)}\n**Available:** **${cusd(s.available)}**\n\nNext day in ${dur(s.nextDayIn)}, week bonus in ${dur(s.nextWeekIn)}.`);
export const earnRoomButtons = (id) => [row(btn(`nx:st-cancel:${id}`, 'Cancel request', ButtonStyle.Secondary))];
export const earnAddrButtons = (id, addr) => [row(btn(`nx:st-addryes:${id}:${addr}`, 'Yes, this is correct', ButtonStyle.Primary), btn(`nx:st-addrno:${id}`, 'No, re-enter'))];
export const earnPaidModal = (id) => modal(`nx:st-paidm:${id}`, 'Mark as paid', input('ref', 'Transaction ID or note (optional)', { required: false, max: 200 }));
export const earnPayoutEmbed = (cfg, r, methods) => base(cfg, `Status payout #${r.id}`,
  `**Member:** <@${r.user_id}>\n**Amount:** **${cusd(r.cents)}**\n**Method:** ${methods[r.method]}\n**Send to:** \`${r.details}\`\n**State:** **${r.state}**${r.handled_by ? `\nHandled by <@${r.handled_by}>` : ''}${r.ref ? `\n**Reference:** ${r.ref}` : ''}`);
export const earnPayoutButtons = (id) => [row(btn(`nx:st-paid:${id}`, 'Mark paid', ButtonStyle.Primary), btn(`nx:st-rej:${id}`, 'Reject', ButtonStyle.Danger))];

// ---------------- fee explainer ----------------
export function feesPanelPayload(cfg) {
  const f = cfg.fee; const m = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const flat = Number(f.usd); const pct = f.percent;
  const ex = (a) => { const fee = a > f.percentOver ? a * pct / 100 : a > f.threshold ? flat : 0; return fee; };
  const line = (a) => `**${m(a)}** deal: fee **${ex(a) ? m(ex(a)) : 'free'}**`;
  if (!Number(f.usd) && !Number(f.percent)) {
    const c = new ContainerBuilder().setAccentColor(BRAND.purple)
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(text('## Middleman Fees\n**Every deal is free.** The **Nexora Hub** auto middleman charges **no service fee** on any coin.'))
        .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: 'attachment://status.png' } })))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(text(`**Good to know**\nThe deal limit is **${m(cfg.maxDealUsd ?? 400)}**.\nCrypto **network fees** are paid to the blockchain, not to us. If a deal is cancelled and refunded, the sender gets the funds back **minus the network fee**.\nQuestions? **Open a support ticket.**`));
    return { flags: 1 << 15, components: [c] };
  }
  const c = new ContainerBuilder().setAccentColor(BRAND.purple)
    .addSectionComponents(new SectionBuilder().addTextDisplayComponents(text('## Middleman Fees\nHere is exactly what the **Nexora Hub** auto middleman costs. The bot shows the final amounts before anything is confirmed.'))
      .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: 'attachment://status.png' } })))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text(`**LTC, SOL and ETH**\n**Free** on every deal.\n\n**Stablecoins (${(cfg.feeAssets ?? []).join(', ')})**\n**Up to ${m(f.threshold)}:** free\n**Over ${m(f.threshold)}:** flat **${m(flat)}**\n**Over ${m(f.percentOver)}:** **${pct}%** of the deal`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text(`**Examples**\n${[f.threshold, f.threshold + 50, f.percentOver, 400].map(line).join('\n')}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text('**Who pays?**\nThe **Sender** chooses: **Sender pays**, **Receiver pays**, or **Split 50/50**. The **Receiver** must then confirm. Nothing is charged until they agree.'))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(text(`**Good to know**\nThe deal limit is **${m(cfg.maxDealUsd ?? 400)}**.\nCrypto **network fees** for sending the payout are separate and paid by the blockchain, not by us.\nIf a deal is cancelled and refunded, the sender gets the funds back **minus the network fee**.\nQuestions? **Open a support ticket.**`));
  return { flags: 1 << 15, components: [c] };
}

// ---------------- giveaways ----------------
export const reqText = (g) => (g.req_kind ? `Invite ${g.req_n} new member${g.req_n === 1 ? '' : 's'} after this giveaway started` : 'None, everyone can enter');
export function giveawayPayload(cfg, g, entries) {
  const ts = Math.floor(g.ends_at / 1000); const ended = g.state === 'ended';
  const winner = g.winner_id ? `<@${g.winner_id}> (picked at random)` : 'No valid entries';
  const e = base(cfg, g.prize, ended
    ? `**Giveaway ended**\n\n**Winner:** ${winner}\n**Hosted by:** <@${g.host_id}>\n**Entries:** ${entries}\n**Giveaway ID:** ${g.id}`
    : `Press **Enter** to join.\n\n**Ends:** <t:${ts}:R> (<t:${ts}:f>)\n**Hosted by:** <@${g.host_id}>\n**Requirement:** ${reqText(g)}\n**Entries:** ${entries}\n**Giveaway ID:** ${g.id}`)
    .setThumbnail('attachment://status.png');
  return { embeds: [e], components: [row(btn(`nx:gw-enter:${g.id}`, ended ? 'Ended' : 'Enter', ButtonStyle.Primary).setDisabled(ended))], allowedMentions: { parse: [] } };
}
export const giveawayLeaveRow = (id) => [row(btn(`nx:gw-leave:${id}`, 'Leave giveaway'))];

// ---------------- polls ----------------
const bar = (pct) => { const n = Math.round(pct / 10); return '▰'.repeat(n) + '▱'.repeat(10 - n); };
export function pollPayload(cfg, p, counts) {
  const opts = JSON.parse(p.options); const total = counts.reduce((a, b) => a + b, 0); const ended = p.state === 'ended';
  const ts = Math.floor(p.ends_at / 1000); const top = Math.max(...counts);
  const lines = opts.map((o, k) => { const pct = total ? Math.round(counts[k] * 100 / total) : 0; return `**${k + 1}. ${o}**${ended && total && counts[k] === top ? '  (winner)' : ''}\n${bar(pct)}  **${pct}%**  (${counts[k]} vote${counts[k] === 1 ? '' : 's'})`; });
  const e = base(cfg, p.question, `${lines.join('\n\n')}\n\n**${ended ? 'Poll ended' : 'Ends'}:** ${ended ? `<t:${ts}:f>` : `<t:${ts}:R> (<t:${ts}:f>)`}\n**Hosted by:** <@${p.host_id}>\n**Total votes:** ${total}${ended ? '' : '\nPress a button to vote. You can change your vote, or press your choice again to remove it.'}`)
    .setThumbnail('attachment://status.png');
  return { embeds: [e], components: [row(...opts.map((o, k) => btn(`nx:pl-vote:${p.id}:${k}`, `${k + 1}. ${o}`.slice(0, 80), ButtonStyle.Primary).setDisabled(ended)))], allowedMentions: { parse: [] } };
}

export function invitesEmbed(cfg, name, avatarUrl, st, list) {
  const e = base(cfg, `${name} - Invites`, st.uses == null ? 'I cannot read the server invites right now, so only tracked joins are shown.' : `**${st.uses}** invite link use${st.uses === 1 ? '' : 's'} all time`)
    .addFields({ name: 'Joined', value: `\`${st.joined}\``, inline: true }, { name: 'Still in server', value: `\`${st.here}\``, inline: true }, { name: 'Left', value: `\`${st.left}\``, inline: true });
  if (list) {
    const t = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
    const lines = list.rows.map((r) => { const made = list.created(r.id); const fresh = Date.now() - made < 7 * 864e5;
      return `<@${r.id}> - ${r.left_at ? '**left**' : 'here'}, joined ${t(Date.parse(r.joined_at))}, account made ${t(made)}${fresh ? ' **(new account)**' : ''}`; });
    e.addFields({ name: 'Invited members', value: (lines.join('\n') + (list.more ? `\n...and ${list.more} more` : '')).slice(0, 1024) || 'Nobody tracked yet.' });
  }
  return avatarUrl ? e.setThumbnail(avatarUrl) : e;
}

export const totalsEmbed = (cfg, st) => base(cfg, 'Nexora Auto MM',
  `**Volume:** $${st.volume.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n**Total Deals:** ${st.deals.toLocaleString('en-US')}`);
