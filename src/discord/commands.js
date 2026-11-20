import { SlashCommandBuilder } from 'discord.js';
export const SIM_EVENTS = ['funds.observed', 'funds.confirmed_on_chain', 'escrow.funded', 'escrow.completed', 'escrow.disputed', 'escrow.cancelled'];
const dealId = (o) => o.setName('deal_id').setDescription('Deal ID, e.g. NXH-AB12CD34').setRequired(true).setMaxLength(12).setMinLength(12);

export const definitions = [
  new SlashCommandBuilder().setName('vouch').setDescription('Leave feedback for a completed deal').setDMPermission(false)
    .addStringOption(dealId)
    .addIntegerOption((o) => o.setName('rating').setDescription('1 to 5').setRequired(true).setMinValue(1).setMaxValue(5))
    .addStringOption((o) => o.setName('feedback').setDescription('Your feedback').setRequired(true).setMinLength(5).setMaxLength(500)),
  new SlashCommandBuilder().setName('ticket').setDescription('Open a private support ticket').setDMPermission(false),
  new SlashCommandBuilder().setName('dispute').setDescription('Open a dispute on a deal').setDMPermission(false)
    .addStringOption(dealId).addStringOption((o) => o.setName('reason').setDescription('What went wrong').setRequired(true).setMinLength(10).setMaxLength(1000)),
  new SlashCommandBuilder().setName('evidence').setDescription('Submit evidence for a deal').setDMPermission(false)
    .addStringOption(dealId).addStringOption((o) => o.setName('note').setDescription('Describe the evidence').setRequired(true).setMinLength(5).setMaxLength(1000))
    .addAttachmentOption((o) => o.setName('file').setDescription('Screenshot or file (evidence only)')),
  new SlashCommandBuilder().setName('mydeals').setDescription('List your recent deals').setDMPermission(false),
  new SlashCommandBuilder().setName('dealinfo').setDescription('Show the live status of a deal').setDMPermission(false).addStringOption(dealId),
  new SlashCommandBuilder().setName('panel').setDescription('Post the Nexora Hub deal panel (staff)').setDMPermission(false).setDefaultMemberPermissions(0),
  new SlashCommandBuilder().setName('staff').setDescription('Staff tools').setDMPermission(false).setDefaultMemberPermissions(0)
    .addSubcommand((s) => s.setName('history').setDescription('Append-only audit history of a deal').addStringOption(dealId))
    .addSubcommand((s) => s.setName('activity').setDescription('Staff activity log').addUserOption((o) => o.setName('member').setDescription('Staff member (default: you)')))
    .addSubcommand((s) => s.setName('claim').setDescription('Claim a deal as its middleman').addStringOption(dealId))
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a deal before funds are involved').addStringOption(dealId).addStringOption((o) => o.setName('reason').setDescription('Logged reason').setRequired(true).setMaxLength(300)))
    .addSubcommand((s) => s.setName('simulate').setDescription('DEMO ONLY: simulate a provider event').addStringOption(dealId)
      .addStringOption((o) => o.setName('event').setDescription('Provider event').setRequired(true).addChoices(...SIM_EVENTS.map((e) => ({ name: e, value: e })))))
    .addSubcommand((s) => s.setName('audit').setDescription('Verify the audit log hash chain'))
    .addSubcommand((s) => s.setName('backup').setDescription('Create a database backup now'))
    .addSubcommand((s) => s.setName('wallet').setDescription('Owner only: wallet network, fee address and recovery phrase (only shown to you)'))
    .addSubcommand((s) => s.setName('refund').setDescription('Owner only: send a deal\'s funds to an address (disputes/refunds)').addStringOption(dealId)
      .addStringOption((o) => o.setName('address').setDescription('LTC address to send everything to').setRequired(true).setMaxLength(100))),
].map((c) => c.toJSON());
