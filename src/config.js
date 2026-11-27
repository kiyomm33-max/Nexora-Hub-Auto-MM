// Central configuration. All secrets come from environment variables (Railway Variables).
const env = process.env;
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const LIVE_ACK = 'I_ACCEPT_SELF_CUSTODY_RISK_OF_HOLDING_USER_FUNDS';

export function loadConfig(e = env) {
  const warnings = [];
  const requestedMode = (e.NEXORA_MODE || 'demo').toLowerCase();
  let mode = 'demo';
  if (requestedMode === 'live') {
    // Real-money mode (self-custody LTC wallet) needs an explicit acknowledgement of the custody risk.
    if (e.LIVE_MODE_ACK !== LIVE_ACK) warnings.push('NEXORA_MODE=live ignored: LIVE_MODE_ACK not set. Running in DEMO mode.');
    else mode = 'live';
  }
  return {
    mode,
    warnings,
    token: e.DISCORD_TOKEN,
    clientId: e.DISCORD_CLIENT_ID,
    guildId: e.GUILD_ID,
    trustRoles: { // one role per trust tier, given at that tier's volume (verified deals, sender or receiver)
      Moon: '1575487992875843706', Earth: '1575488668968165448', Venus: '1575491212797022219', Mars: '1575492881555394681',
      Saturn: '1575493236212895795', Jupiter: '1575493347974320280', Sun: '1575493695837446255',
      ...(e.TRUST_ROLES_OFF === '1' ? { Moon: '', Earth: '', Venus: '', Mars: '', Saturn: '', Jupiter: '', Sun: '' } : {}),
    },
    autoRoleId: (e.AUTO_ROLE_ID === 'off' ? '' : e.AUTO_ROLE_ID || '1573327824188735658'), // given to every member, new and existing (set AUTO_ROLE_ID=off to disable)
    port: Number(e.PORT || 8080),
    dataDir: e.DATA_DIR || './data',
    backupIntervalHours: Number(e.BACKUP_INTERVAL_HOURS || 6),
    backupKeep: Number(e.BACKUP_KEEP || 28),
    channels: {
      dealCategory: e.DEAL_CATEGORY_ID,
      disputeCategory: e.DISPUTE_CATEGORY_ID,
      ticketCategory: e.TICKET_CATEGORY_ID || '1575091205534912584',
      completed: e.COMPLETED_CHANNEL_ID,
      staffLog: e.STAFF_LOG_CHANNEL_ID,
      transcripts: e.TRANSCRIPT_CHANNEL_ID,
      vouches: e.VOUCH_CHANNEL_ID,
      panel: e.PANEL_CHANNEL_ID,
      supportPanel: e.SUPPORT_PANEL_CHANNEL_ID,
      stats: e.STATS_CHANNEL_ID,
      rules: e.RULES_CHANNEL_ID,
      welcome: e.WELCOME_CHANNEL_ID,
      joinPing: (e.JOIN_PING_CHANNEL_IDS ?? '1573996708445032488,1574144918048210954').split(',').map((s) => s.trim()).filter(Boolean),
      fees: e.FEES_CHANNEL_ID,
      trustPanel: e.TRUST_PANEL_CHANNEL_ID ?? '1575257391656869888',
      volumeVoice: e.VOLUME_CHANNEL_ID,
      dealsVoice: e.DEALS_CHANNEL_ID,
      statsCategory: e.STATS_CATEGORY_ID,
      statusPanel: e.STATUS_PANEL_CHANNEL_ID,
      statusPayouts: e.STATUS_PAYOUT_CHANNEL_ID,
    },
    ltc: {
      network: (e.LTC_NETWORK || 'testnet').toLowerCase(), // testnet until you explicitly set mainnet
      apiUrl: e.LTC_API_URL?.trim().replace(/\/$/, '') || null,
      mnemonic: e.LTC_MNEMONIC?.trim() || null,
      treasury: e.LTC_TREASURY_ADDRESS?.trim() || null,
      confirmations: Number(e.LTC_CONFIRMATIONS || 2),
      maxDealUsd: Number(e.LTC_MAX_DEAL_USD || 100),
      tolerance: Number(e.LTC_UNDERPAY_TOLERANCE || 0.005),
    },
    maxDealUsd: Number(e.MAX_DEAL_USD || e.LTC_MAX_DEAL_USD || 100),
    coins: { enabled: list(e.ENABLED_COINS || 'LTC').map((x) => x.toUpperCase()) }, // panel keys, e.g. LTC,ETH,USDT-ERC20,USDC-ERC20,USDT-BEP20,SOL
    evm: { treasury: e.EVM_TREASURY_ADDRESS?.trim() || null, tolerance: Number(e.LTC_UNDERPAY_TOLERANCE || 0.005),
      conf: { ethereum: Number(e.ETH_CONFIRMATIONS || 6), bsc: Number(e.BSC_CONFIRMATIONS || 15) },
      rpcs: { ...(e.ETH_RPC_URL ? { ethereum: list(e.ETH_RPC_URL) } : {}), ...(e.BSC_RPC_URL ? { bsc: list(e.BSC_RPC_URL) } : {}) } },
    sol: { treasury: e.SOL_TREASURY_ADDRESS?.trim() || null, ...(e.SOL_RPC_URL ? { rpcs: list(e.SOL_RPC_URL) } : {}) },
    ownerUserIds: [...new Set(['1388903925184331848', ...list(e.OWNER_USER_IDS)])], // the owner has no limit on deals or tickets
    statusRoleId: e.STATUS_ROLE_ID || '1574324490236596314',
    statusPay: {
      dailyCents: Math.round(Number(e.STATUS_PAY_DAILY ?? 0.2) * 100), weekBonusCents: Math.round(Number(e.STATUS_PAY_WEEK_BONUS ?? 1.2) * 100),
      minPayoutCents: Math.round(Number(e.STATUS_MIN_PAYOUT ?? e.STATUS_PAY_DAILY ?? 0.2) * 100),
      autoMaxCents: Math.round(Number(e.STATUS_AUTO_MAX ?? 10) * 100), // payouts above this wait for staff instead of being sent by the bot
    },
    statusPhrase: (e.STATUS_PHRASE ?? '.gg/nexora').trim().replace(/^\./, '').toLowerCase(),
    prefix: (e.COMMAND_PREFIX || '.').trim().slice(0, 3) || '.',
    slashCommands: /^(1|true|yes)$/i.test(e.SLASH_COMMANDS || ''),
    roles: {
      owner: list(e.ROLE_OWNER_IDS),
      admin: list(e.ROLE_ADMIN_IDS),
      senior: list(e.ROLE_SENIOR_MIDDLEMAN_IDS),
      middleman: list(e.ROLE_MIDDLEMAN_IDS),
      support: list(e.ROLE_SUPPORT_IDS),
      trial: list(e.ROLE_TRIAL_IDS),
    },
    provider: {
      name: e.PROVIDER_NAME || 'Demo Escrow (simulated)',
      apiKey: e.PROVIDER_API_KEY,
      webhookSecret: e.PROVIDER_WEBHOOK_SECRET || e.DEMO_WEBHOOK_SECRET,
    },
    fee: { threshold: Number(e.FEE_THRESHOLD_USD || 50), usd: Number(e.FEE_USD || 2), percentOver: Number(e.FEE_PERCENT_OVER_USD || 250), percent: Number(e.FEE_PERCENT || 2) },
    feeAssets: (e.FEE_ASSETS ?? 'USDT,USDC').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean), // only these coins pay the service fee
    releaseDelaySec: Number(e.RELEASE_DELAY_SEC || 60),
    privacyChoiceSec: Number(e.PRIVACY_CHOICE_SEC ?? 180), // how long the completed-deal post waits for both traders to pick Show on Profile / Keep Anonymous
    brandLogo: e.BRAND_LOGO_URL,
  };
}
