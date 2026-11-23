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
    port: Number(e.PORT || 8080),
    dataDir: e.DATA_DIR || './data',
    backupIntervalHours: Number(e.BACKUP_INTERVAL_HOURS || 6),
    backupKeep: Number(e.BACKUP_KEEP || 28),
    channels: {
      dealCategory: e.DEAL_CATEGORY_ID,
      disputeCategory: e.DISPUTE_CATEGORY_ID,
      ticketCategory: e.TICKET_CATEGORY_ID,
      completed: e.COMPLETED_CHANNEL_ID,
      staffLog: e.STAFF_LOG_CHANNEL_ID,
      transcripts: e.TRANSCRIPT_CHANNEL_ID,
      vouches: e.VOUCH_CHANNEL_ID,
      panel: e.PANEL_CHANNEL_ID,
      supportPanel: e.SUPPORT_PANEL_CHANNEL_ID,
      stats: e.STATS_CHANNEL_ID,
      rules: e.RULES_CHANNEL_ID,
      welcome: e.WELCOME_CHANNEL_ID,
      fees: e.FEES_CHANNEL_ID,
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
    ownerUserIds: list(e.OWNER_USER_IDS),
    statusRoleId: e.STATUS_ROLE_ID || '1574324490236596314',
    statusPay: {
      dailyCents: Math.round(Number(e.STATUS_PAY_DAILY ?? 0.2) * 100), weekBonusCents: Math.round(Number(e.STATUS_PAY_WEEK_BONUS ?? 1.2) * 100),
      minPayoutCents: Math.round(Number(e.STATUS_MIN_PAYOUT ?? e.STATUS_PAY_DAILY ?? 0.2) * 100),
    },
    statusPhrase: (e.STATUS_PHRASE ?? '.gg/nexorra').trim().replace(/^\./, '').toLowerCase(),
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
    fee: { threshold: Number(e.FEE_THRESHOLD_USD || 50), usd: Number(e.FEE_USD || 0), percentOver: Number(e.FEE_PERCENT_OVER_USD || 250), percent: Number(e.FEE_PERCENT || 0) },
    releaseDelaySec: Number(e.RELEASE_DELAY_SEC || 60),
    brandLogo: e.BRAND_LOGO_URL,
  };
}
