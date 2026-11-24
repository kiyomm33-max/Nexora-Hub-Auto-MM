import { SlashCommandBuilder as SCB, PermissionFlagsBits } from 'discord.js';
// Every command is visible to server administrators only, except /stats.
class SlashCommandBuilder extends SCB { constructor() { super(); this.setDefaultMemberPermissions(PermissionFlagsBits.Administrator); } }
export const SIM_EVENTS = ['funds.observed', 'funds.confirmed_on_chain', 'escrow.funded', 'escrow.completed', 'escrow.disputed', 'escrow.cancelled'];
const dealId = (o) => o.setName('deal_id').setDescription('Deal ID, e.g. NXH-AB12CD34').setRequired(true).setMaxLength(12).setMinLength(12);

export const definitions = [
  new SCB().setName('stats').setDescription('Show deal stats and rank').setDMPermission(false).setDefaultMemberPermissions(null)
    .addUserOption((o) => o.setName('member').setDescription('Member to look up (default: you)')),
  new SCB().setName('leaderboard').setDescription('Who sent the most messages').setDMPermission(false).setDefaultMemberPermissions(null)
    .addStringOption((o) => o.setName('period').setDescription('today, week, month or all').addChoices(...['today', 'week', 'month', 'all'].map((x) => ({ name: x, value: x })))),
  new SCB().setName('messages').setDescription('How many messages a member sent').setDMPermission(false).setDefaultMemberPermissions(null)
    .addUserOption((o) => o.setName('member').setDescription('Member to look up (default: you)')),
  new SCB().setName('inviteboard').setDescription('Top inviters').setDMPermission(false).setDefaultMemberPermissions(null),
  new SCB().setName('invites').setDescription('How many people a member invited').setDMPermission(false).setDefaultMemberPermissions(null)
    .addUserOption((o) => o.setName('member').setDescription('Member to look up (default: you)')),
  new SlashCommandBuilder().setName('check').setDescription('Show everyone who entered the current giveaway (staff)').setDMPermission(false)
    .addIntegerOption((o) => o.setName('id').setDescription('Giveaway ID (default: the current giveaway)')),
  new SlashCommandBuilder().setName('totals').setDescription('Create the locked voice channels showing total volume and deals (staff)').setDMPermission(false),
  new SlashCommandBuilder().setName('steal').setDescription('Add custom emoji to this server (staff)').setDMPermission(false)
    .addStringOption((o) => o.setName('emoji').setDescription('The emoji to add')),
  new SlashCommandBuilder().setName('role').setDescription('Mass role tools (staff)').setDMPermission(false)
    .addSubcommand((s) => s.setName('all').setDescription('Give a role to every member of the server')
      .addRoleOption((o) => o.setName('role').setDescription('The role to give everyone').setRequired(true))),
  new SlashCommandBuilder().setName('tag').setDescription('Server tag and status history of a member (staff)').setDMPermission(false)
    .addUserOption((o) => o.setName('member').setDescription('Member to look up (default: you)')),
  new SlashCommandBuilder().setName('tags').setDescription('Server tag and status leaderboard (staff)').setDMPermission(false),
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
  new SlashCommandBuilder().setName('welcome').setDescription('Post a welcome message preview to the welcome channel (staff)').setDMPermission(false),
  new SlashCommandBuilder().setName('fees').setDescription('Post the fee explanation panel (staff)').setDMPermission(false),
  new SlashCommandBuilder().setName('poll').setDescription('Ask the community to vote (staff)').setDMPermission(false)
    .addSubcommand((s) => {
      s.setName('create').setDescription('Start a poll')
        .addStringOption((o) => o.setName('question').setDescription('What are you asking?').setRequired(true).setMaxLength(250))
        .addStringOption((o) => o.setName('duration').setDescription('When it ends: 30m, 12h, 1d or 2d12h').setRequired(true).setMaxLength(20))
        .addStringOption((o) => o.setName('option1').setDescription('First choice').setRequired(true).setMaxLength(80))
        .addStringOption((o) => o.setName('option2').setDescription('Second choice').setRequired(true).setMaxLength(80));
      for (const n of [3, 4, 5]) s.addStringOption((o) => o.setName(`option${n}`).setDescription(`Choice ${n} (optional)`).setMaxLength(80));
      return s.addChannelOption((o) => o.setName('channel').setDescription('Channel to post in (default: here)').addChannelTypes(0, 5));
    })
    .addSubcommand((s) => s.setName('end').setDescription('End a poll now and show the result').addIntegerOption((o) => o.setName('id').setDescription('Poll ID').setRequired(true))),
  new SlashCommandBuilder().setName('giveaway').setDescription('Run giveaways (staff)').setDMPermission(false)
    .addSubcommand((s) => s.setName('create').setDescription('Start a giveaway with a random winner')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel to post in').setRequired(true).addChannelTypes(0, 5))
      .addStringOption((o) => o.setName('duration').setDescription('For example 30m, 12h, 1d or 2d12h').setRequired(true).setMaxLength(20))
      .addStringOption((o) => o.setName('prize').setDescription('What is being given away').setRequired(true).setMaxLength(200))
      .addIntegerOption((o) => o.setName('invites').setDescription('New invites a member needs to enter (optional)').setMinValue(1).setMaxValue(100)))
    .addSubcommand((s) => s.setName('end').setDescription('End a giveaway now and draw a random winner').addIntegerOption((o) => o.setName('id').setDescription('Giveaway ID').setRequired(true)))
    .addSubcommand((s) => s.setName('reroll').setDescription('Draw a new random winner').addIntegerOption((o) => o.setName('id').setDescription('Giveaway ID').setRequired(true))),
  new SlashCommandBuilder().setName('rules').setDescription('Post the server rules (staff)').setDMPermission(false),
  new SlashCommandBuilder().setName('status').setDescription('Post the Status Rewards panel (staff)').setDMPermission(false).setDefaultMemberPermissions(0),
  new SlashCommandBuilder().setName('supportpanel').setDescription('Post the Nexora Hub support panel (staff)').setDMPermission(false).setDefaultMemberPermissions(0),
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
    .addSubcommand((s) => s.setName('lockrooms').setDescription('Owner only: hide all open deal and ticket rooms from roles below admin'))
    .addSubcommand((s) => s.setName('refund').setDescription('Owner only: send a deal\'s funds to an address (disputes/refunds)').addStringOption(dealId)
      .addStringOption((o) => o.setName('address').setDescription('LTC address to send everything to').setRequired(true).setMaxLength(100))),
].map((c) => c.toJSON());
