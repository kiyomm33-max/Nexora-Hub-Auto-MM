import { UserSelectMenuBuilder, ContainerBuilder, SectionBuilder, TextDisplayBuilder, SeparatorBuilder, StringSelectMenuBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
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
export function completedEmbed(cfg, d, names, info) {
  const coin = Object.values(COINS).find((c) => c.asset === d.asset && c.network === d.network);
  const coinLabel = (coin?.label ?? d.asset).replace(/ \[.*\]/, '');
  const demo = d.mode === 'demo' ? '**DEMO deal** — simulated, no real funds.\n' : '';
  const e = base(cfg, `${coinLabel} Deal Complete`, demo || null, BLUE);
  const amount = info?.amount ? `\`${info.amount}\` ${d.asset} (**$${d.receive_usd ?? d.amount} USD**)` : `**$${d.receive_usd ?? d.amount} USD** in ${d.asset}`;
  e.addFields({ name: 'Amount', value: amount },
    { name: 'Sender', value: names.sender ?? names.a, inline: true }, { name: 'Receiver', value: names.receiver ?? names.b, inline: true });
  if (info?.txid) e.addFields({ name: 'Transaction', value: `\`${shortTx(info.txid)}\` ([View Transaction](${info.url}))` });
  e.addFields({ name: 'Deal ID', value: `\`${d.id}\``, inline: true }, { name: 'Completed', value: ts(d.completed_at), inline: true });
  if (names.middleman) e.addFields({ name: 'Middleman', value: names.middleman, inline: true });
  return e;
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
export const DEAL_TYPES = [
  { value: 'in-game', label: 'In-Game', description: 'Deal involving Roblox in-game items' },
  { value: 'exchange', label: 'Exchange', description: 'Deal involving currency exchange' },
  { value: 'counter-strike', label: 'Counter Strike', description: 'Deal involving CS' },
  { value: 'robux', label: 'Robux', description: 'Deal involving Roblox Robux' },
  { value: 'other', label: 'Other', description: 'Deal involves something else' },
];
export const coinName = (d) => Object.values(COINS).find((c) => c.asset === d.asset && c.network === d.network)?.label ?? `${d.asset} (${d.network})`;
const text = (t) => new TextDisplayBuilder().setContent(t);
import { emojiMap } from './emojis.js';
export const coinIcon = (c) => emojiMap.get(c.asset) ?? c.mark;
const section = (t, key) => new SectionBuilder().addTextDisplayComponents(text(t))
  .setButtonAccessory(new ButtonBuilder().setCustomId(`nx:am-start:${key}`).setLabel('Start').setStyle(ButtonStyle.Primary));

/** Components V2 panel: one row per coin with its own Start button. */
export function panelPayload(cfg, mode) {
  const mk = (title, intro, keys) => {
    const c = new ContainerBuilder().setAccentColor(BRAND.purple).addTextDisplayComponents(text(`## ${title}\n${intro}`));
    for (const k of keys) { c.addSeparatorComponents(new SeparatorBuilder()); c.addSectionComponents(section(`${coinIcon(COINS[k])}  **${COINS[k].label}**`, k)); }
    return c;
  };
  const demo = mode === 'demo' ? '\n**DEMO MODE** — simulated escrow, no real funds.' : '';
  const on = (keys) => (mode === 'live' ? keys.filter((k) => cfg.coins?.enabled?.includes(k)) : keys);
  const main = on(['ETH', 'LTC', 'SOL']); const stable = on(['USDT-ERC20', 'USDC-ERC20', 'USDT-BEP20']);
  return { flags: 1 << 15, components: [
    mk('Start Cryptocurrency Deal', `Use the selection below to start a deal with the appropriate coin & network. Be sure all deals abide by the rules. **Nexora Hub** never asks for passwords, 2FA codes or seed phrases.${demo}`, main),
    ...(stable.length ? [mk('Stablecoins', 'Start a deal with USDT or USDC on the network that matches your wallet. Be sure to select the correct network.', stable)] : []),
  ] };
}
const usdFmt = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
export const startedEmbeds = (cfg, d) => [
  base(cfg, `${(() => { const c = Object.values(COINS).find((x) => x.asset === d.asset && x.network === d.network); return c ? coinIcon(c) : ''; })()}  Deal Started — ${coinName(d)}`, `Welcome to the **Nexora Hub** automated cryptocurrency middleman system.\n\n**Deal ID:** \`${d.id}\`\nPlease **contact support** if you need assistance.${d.mode === 'demo' ? '\n\n**DEMO MODE** — simulated escrow, no real funds.' : ''}`),
  base(cfg, 'Safety Warning', 'The bot and our support team will **NEVER** direct message you. Keep every conversation about the deal **inside this ticket**. Nobody from Nexora Hub will ever ask for **passwords, 2FA codes, cookies, seed phrases or private keys**.', BRAND.red),
];
export const closeButton = (id) => [row(btn(`nx:am-close:${id}`, 'Close'))];

const votesText = (d, set) => Object.entries(set.votes ?? {}).map(([u, v]) => `<@${u}>: **${v}**`).join('\n') || 'No answers yet.';
const parties = (d) => `<@${d.party_a}>${d.party_b ? ` and <@${d.party_b}>` : ''}`;

/** The step shown while a deal is still being set up (status: waiting_parties). */
export function stepPayload(cfg, d, set) {
  const step = set.step;
  const e = (t, desc) => base(cfg, t, desc);
  switch (step) {
    case 'type': return { embeds: [e('Deal Type', 'To best serve you, we need to know a few deal details. Please use the dropdown menu below to select the **deal type**:')],
      components: [row(new StringSelectMenuBuilder().setCustomId(`nx:am-type:${d.id}`).setPlaceholder('Select Deal Type').addOptions(DEAL_TYPES))] };
    case 'partner': return cfg.messageContent
      ? { embeds: [e('Add the other trader', `<@${d.party_a}>, **mention the trader** you are dealing with (**@user**) or send their **Discord user ID** in this channel.`)], components: [] }
      : { embeds: [e('Add the other trader', `<@${d.party_a}>, press the button and enter the **Discord user ID** of the trader you are dealing with.`)],
          components: [row(btn(`nx:am-partnerid:${d.id}`, 'Enter user ID', ButtonStyle.Primary))] };
    case 'roles': {
      const who = (r) => { const u = Object.keys(set.votes ?? {}).find((x) => set.votes[x] === r); return u ? `<@${u}>` : 'None'; };
      const coin = coinName(d);
      const pick = (label, r) => new SectionBuilder().addTextDisplayComponents(text(`**${label} ${coin}:** ${who(r)}`)).setButtonAccessory(btn(`nx:am-role:${d.id}:${r}`, 'Select', ButtonStyle.Primary));
      const box = new ContainerBuilder().setAccentColor(BLUE)
        .addTextDisplayComponents(text('## Role Selection\nSelect **one of the following buttons** that corresponds to **your role** in this deal.'))
        .addSeparatorComponents(new SeparatorBuilder()).addSectionComponents(pick('Sending', 'sender'))
        .addSeparatorComponents(new SeparatorBuilder()).addSectionComponents(pick('Receiving', 'receiver'));
      return { flags: 1 << 15, components: [text(`${parties(d)} Welcome! Select roles below.`), box, row(btn(`nx:am-rolereset:${d.id}`, 'Reset', ButtonStyle.Danger))] };
    }
    case 'describe': return { embeds: [e('Deal Details', `Before continuing, please write out **all deal details** such as usernames, amounts, and items being traded.\n\n**Type:** ${DEAL_TYPES.find((t) => t.value === d.deal_type)?.label ?? 'Other'}\n**Sender:** <@${d.sender_id}>  **Receiver:** <@${d.receiver_id}>\n\n**Ex.** \`Brief summary of who sends what to whom\`\nThe other trader will then be asked to accept it.`)],
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
    { name: 'Deal', value: `${d.deal_type ?? '—'}: ${d.item || '—'}` },
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
    return d.escrow_status === 'provider_confirmed' ? 'received' : 'detected';
  }
  return d.status;
};

export function summaryEmbed(cfg, d) {
  const type = DEAL_TYPES.find((t) => t.value === d.deal_type)?.label ?? 'Other';
  const e = base(cfg, 'Deal Summary', `Refer to this deal summary for any reaffirmations. Notify staff for any support required.${d.mode === 'demo' ? '\n**DEMO MODE** — simulated escrow, no real funds.' : ''}`)
    .addFields({ name: 'Sender', value: `<@${d.sender_id}>` }, { name: 'Receiver', value: `<@${d.receiver_id}>` }, { name: 'Coin', value: coinName(d) },
      { name: 'Deal Amount', value: `\`${usd(d.amount)}\`` });
  if (Number(d.fee_usd)) e.addFields({ name: 'Fee', value: `\`${usd(d.fee_usd)}\` — ${FEE_LABEL[d.fee_payer]}\nSender sends \`${usd(d.send_usd)}\`, receiver gets \`${usd(d.receive_usd)}\`` });
  return e.addFields({ name: 'Deal', value: `${type} - ${d.item}` });
}
export function invoiceEmbed(cfg, d) {
  const demo = d.mode === 'demo';
  const e = base(cfg, 'Payment Invoice', `<@${d.sender_id}> **Send the funds** to the escrow address below. Please copy the **exact amount** provided.${demo ? '\n**DEMO — this address is NOT real. Do not send real funds.**' : ''}`)
    .addFields({ name: 'Address', value: `\`${d.pay_address}\`` },
      { name: 'Amount', value: `\`${d.pay_amount}\` ${d.asset} (${usd(d.send_usd)} USD)\nExchange Rate: 1 ${d.asset} = ${d.rate_usd} USD${demo ? ' (DEMO rate)' : ''}` },
      { name: 'Network', value: d.network, inline: true });
  return e;
}
export function detectedEmbed(cfg, d) {
  return base(cfg, 'Transaction Detected', 'Your payment has been **detected** on the network.\nPlease wait while it receives the **required confirmations**.\n*Blockchain observation only — not escrow confirmation.*', BLUE)
    .addFields({ name: 'Transaction', value: txLink(d.tx_hash) }, { name: 'Amount Received', value: d.received_crypto ? `\`${d.received_crypto}\` ${d.asset} ≈ ${usd(d.send_usd)} USD` : 'Pending' },
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
  if (phase === 'received') rows.push(row(btn(`nx:am-release:${d.id}`, 'Release', ButtonStyle.Primary).setDisabled(!!d.release_at)));
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
