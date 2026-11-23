import { EmbedBuilder } from 'discord.js';
import { BRAND } from './ui.js';

const SECTIONS = [
  ['Nexora Hub Rules', 'By using this server or the auto middleman you agree to every rule below. **Not knowing the rules is not an excuse.** Staff decisions are final unless an owner overturns them.'],
  ['1. General Conduct', [
    '**Be respectful.** No harassment, hate speech, threats, slurs or targeted insults.',
    '**No spam**, advertising, invite links, self-promotion or begging.',
    '**No NSFW, illegal or shocking content.**',
    'Follow the **Discord Terms of Service** and Community Guidelines at all times.',
    'Use channels for their purpose and **speak English** in public channels.',
    '**No impersonation** of staff, members or the bot.',
  ]],
  ['2. Staying Safe', [
    '**Nexora Hub staff and the bot will NEVER DM you first.** Anyone who does is a scammer. Report them in a ticket.',
    '**Never share** passwords, 2FA codes, cookies, seed phrases or private keys. Nobody here will ever ask for them.',
    '**Keep every deal inside its ticket.** Do not move to DMs or other servers.',
    '**Never click links or run files** sent by other members.',
    '**Never trust screenshots** as proof of payment. Only the bot\'s verified updates count.',
    'If something feels wrong, **stop and open a support ticket.**',
  ]],
  ['3. Auto Middleman Deals', [
    'Start a deal from the **deal panel**. Each deal gets a **private room** that only the two traders and admins can see.',
    'Add your trader by **typing their @mention or user ID** in the room, then pick roles: **Sender** (pays crypto) and **Receiver** (gets the crypto).',
    '**Check every detail** before you confirm. Confirmed deals cannot be edited.',
    'Send the **exact amount** to the **exact address** the bot shows, on the **correct network**, in a **single transaction**.',
    'Only deposit funds when the bot **asks you to**. Never send funds to a deal address from an old or different deal.',
    'The Receiver **types their own payout address** in the room and confirms it. **Double-check it:** payouts are on-chain and **cannot be reversed**.',
    'The Sender presses **Release** only after the **trade has been delivered** as agreed. Release is final.',
    'You may only trade **items that are allowed by Roblox and Discord rules.** Scams, stolen accounts and exploited items are banned.',
  ]],
  ['4. Payments, Networks and Fees', [
    '**Wrong network, wrong coin, wrong address or wrong amount can mean lost funds.** We cannot guarantee recovery.',
    'Supported coins and networks are listed on the deal panel. **Only use what is shown.** ETH and BNB Smart Chain share the same deal address, so **choose the right network.**',
    'A deal only counts as funded after the **required blockchain confirmations**. Waiting is normal.',
    'Underpaying means the deal **does not fund.** Contact support instead of sending more on your own.',
    '**Service fee:** none. **Every deal is free.**',
    '**Deal limits** are shown in the deal room. Network fees are paid out of the deal amount.',
    'Payouts are sent automatically after Release. The **transaction ID** is posted in the room and in the completed-deals channel.',
  ]],
  ['5. Tickets, Disputes and Support', [
    'Open support from the **support panel**. Tickets are private to you and the admins.',
    'Be **honest and clear.** Give your deal ID and a short description. **Staff may ask for evidence.**',
    '**Fake reports, false claims or abusing tickets** will be punished.',
    '**Do not ping staff** repeatedly. Wait for a reply in your ticket.',
    'Only owners and admins can decide refunds or manual payouts. **The bot never decides a dispute on its own.**',
    'Deal rooms close **automatically** after a finished deal and a **transcript is saved**.',
  ]],
  ['6. Punishments', [
    'Breaking rules can lead to a **warning, mute, ticket ban, kick or permanent ban**, depending on severity.',
    '**Scamming, chargeback or payment fraud, or attempting to exploit the bot = permanent ban** and a public report.',
    'Evading a ban with an alternate account results in a ban on **all** accounts.',
    'Appeals go through a **support ticket.**',
  ]],
];

export const rulesPayload = () => ({
  embeds: SECTIONS.map(([title, body], n) => new EmbedBuilder().setColor(BRAND.blue).setTitle(title)
    .setDescription(Array.isArray(body) ? body.map((x) => `- ${x}`).join('\n') : body)),
  allowedMentions: { parse: [] },
});
