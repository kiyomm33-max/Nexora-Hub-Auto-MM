# Nexora Hub — automated middleman Discord bot

Purple / black / white deal-management bot for a Roblox middleman server. **Runs in DEMO mode by default: no real money is ever handled.**

## Auto-MM flow (panel button → release)
1. `/panel` (admin) posts the coin panel (one **Start** button per coin/network) in `PANEL_CHANNEL_ID`.
2. Start opens a private room: Deal Started, Safety Warning, Close, then **Deal Type** dropdown (In-Game, Exchange, Counter Strike, Robux, Other).
3. Creator adds the other trader (user picker or user ID/ping) → each trader picks Sender or Receiver → one describes the deal, the other accepts/declines → USD amount → both confirm.
4. At or above `FEE_THRESHOLD_USD` a `FEE_USD` fee applies and both traders must pick the same payer: sender (sender sends amount + fee), receiver (receiver gets amount − fee) or split.
5. **Deal Summary** + **Payment Invoice** (provider-issued address, crypto amount, exchange rate, QR). Then **Transaction Detected** (tx hash, amount, required confirmations — an on-chain observation only), then **Payment Received** ("secured" only after the provider confirms escrow) with **Release** / **Cancel**.
6. Release (sender only) → "Are you sure?" → visible 60 s countdown the releaser can cancel → release approved at the provider.
7. The receiver presses **Provide address** (format-checked, then an explicit confirmation) → payout requested from the provider → provider confirms completion → deal completed, published to `#completed-deals`.
**Cancel** after payment is handled as a dispute: refunds are decided by the provider, not by the bot or staff.
The bot only calculates and displays amounts and requests release; the provider holds and moves funds and collects the fee. In demo mode the address is a visibly fake placeholder and `/staff simulate` plays the provider's payment events.

## What it does
- `/deal` (or the panel's **Start a deal** button): modal for Roblox usernames, item, value (`25.00 USD`), crypto + network → proposal embed → **both parties confirm** → private deal room with a live status embed.
- Statuses: Waiting for both parties → Awaiting external provider verification → Verification pending → Completed, plus Disputed and Cancelled. Illegal transitions are rejected in code and completed/cancelled deals are locked by a DB trigger.
- Verification shows **blockchain observations** and **provider escrow confirmation** separately. The bot says funds are secured only when the provider has confirmed it; otherwise every deal embed states "Funds are NOT confirmed as secured".
- Completion happens **only** from a signature-verified provider event, and only after the provider confirmed funding. Duplicate/replayed events are no-ops (event-ID dedupe + conditional update), so a deal completes and publishes once.
- `#completed-deals` post: deal ID, both Discord usernames, middleman, date. No item, value, crypto, wallet or provider data.
- `/vouch` (also a button): only participants of a provider-completed deal, one per person per deal, rating 1–5, stored immutably.
- Support tickets (`/ticket`), disputes (`/dispute`, button), evidence (`/evidence`, button), staff-assist buttons, transcripts (SHA-256 stored + sent to transcript channel), private staff review channel per dispute.
- Staff: Owner, Administrator, Senior Middleman, Middleman, Support, Trial Staff mapped to Discord role IDs. `/staff history|activity|claim|cancel|simulate|audit|backup`, `/panel`.

| Capability | Minimum role |
|---|---|
| Handle tickets | Trial Staff |
| Review disputes, view deal history, see deal rooms | Support |
| Claim deals | Middleman |
| Cancel deals (pre-funds), view others' activity | Senior Middleman |
| Panel, backup, audit verify, demo simulate | Administrator |

Guild owner is treated as Owner. Denied attempts are written to the audit log.

## Money safety (by design)
The bot has no wallet code, never sees keys/seed phrases/passwords, never signs or transfers anything, and has no command that releases funds. Disputes are recorded and **referred to the provider**; staff cannot resolve them. Screenshots are stored as evidence only.

## Records
`audit_log` is append-only (DB triggers block UPDATE/DELETE) and hash-chained; `/staff audit` re-verifies the chain, so even DB-level edits are detectable. Deals, evidence, vouches and webhook events cannot be deleted or rewritten. Simulated events are flagged `simulated` everywhere.

## Real-money mode: NOT enabled, no provider bundled
Live mode is a **self-custody Litecoin wallet** (`src/providers/ltc.js`): the bot derives one deposit address per deal from an HD seed, watches the chain through the public litecoinspace.org API, marks funds "secured" only after `LTC_CONFIRMATIONS` confirmations of at least the quoted amount, and signs + broadcasts the payout itself after the sender releases and the receiver confirms an address. The payout pays the receiver everything except the service fee (sent to the fee address) and the network fee. **The seed controls all deposits: you carry the custody and legal risk.**

Enable it with `NEXORA_MODE=live`, `LIVE_MODE_ACK=I_ACCEPT_SELF_CUSTODY_RISK_OF_HOLDING_USER_FUNDS` and, optionally, `LTC_NETWORK` (**`testnet` by default** — set `mainnet` only after a full testnet run), `LTC_MNEMONIC` (otherwise a phrase is generated on the data volume on first start; the owner reads it once with `/staff wallet`), `LTC_TREASURY_ADDRESS` (fee address, default: a second address of the same wallet), `LTC_CONFIRMATIONS` (2), `LTC_MAX_DEAL_USD` (100), `LTC_UNDERPAY_TOLERANCE` (0.005). Live mode offers LTC only. Back up the phrase offline; losing it loses funds in flight. Disputes and refunds are decided by the owner with `/staff refund` (sweeps a deal address to an address you choose, audited).

### Webhook contract — `POST /webhooks/provider`
Header `X-Nexora-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, 5-minute tolerance, constant-time compare, 64 KB limit, 60 req/min per IP. Body:
`{"id":"unique-event-id","type":"funds.observed|funds.confirmed_on_chain|escrow.funded|escrow.completed|escrow.disputed|escrow.cancelled","reference":"<provider ref>","confirmations":1,"txid":"...","amount":"0.04852013","required_confirmations":1}` (txid/amount/required_confirmations optional). `escrow.completed` is rejected until the receiver has submitted a payout address.
Only `escrow.*` events from the provider change escrow state; `funds.*` are labelled observations.

## Setup
1. Discord Developer Portal: create an application + bot, copy token and application ID. Invite with scopes `bot applications.commands` and permissions: Manage Channels, View Channels, Send Messages, Embed Links, Attach Files, Read Message History. No privileged intents are needed.
2. In your server create: a deal category, dispute category, ticket category, and channels `#completed-deals`, `#vouches`, `#staff-log`, `#transcripts` (make the last two staff-only). Create the six staff roles. Copy IDs (Developer Mode).
3. Fill variables from `.env.example`. Commands register automatically on startup (`npm run deploy-commands` does it manually).
4. Run `/panel` in your public channel.

## Deploy on Railway
1. Push this repo to GitHub, create a Railway service from it (`railway.json` sets start command, `/health` check and restart-on-failure).
2. **Add a Volume mounted at `/data`** and set `DATA_DIR=/data` — SQLite lives there, as do backups in `/data/backups` (VACUUM snapshots every `BACKUP_INTERVAL_HOURS`, `BACKUP_KEEP` retained). Without a volume, data is lost on redeploy.
3. Add the variables above in the service's Variables tab. Never commit secrets.
4. Generate a public domain only if you need the webhook endpoint. `/health` returns 503 until Discord is connected.
Crash recovery: unknown fatal errors exit and Railway restarts; on startup, completed deals missing their `#completed-deals` post are re-published. Restore a backup by copying a snapshot over `/data/nexora.sqlite` while stopped.

## Develop / test
`npm i && npm test` (no Discord token needed). `DATA_DIR=./data npm start` runs HTTP + health without a token.
Layout: `src/core` (deal state machine, audit, validation, permissions, rate limits), `src/providers`, `src/web` (health + webhook), `src/discord` (UI, rooms, handlers, commands), `src/jobs` (backups).

## Tested vs not tested
Tested (automated): state machine and every status, duplicate/replayed completion, webhook signature (bad/stale/replay/oversize), permissions for every staff command, vouch rules, audit tamper detection, backups, validation, rate limits, and the full deal → dispute → completed → vouch flow through the real handlers using **fake Discord objects**.
**Not tested:** anything against the live Discord API (channel permissions as Discord enforces them, modal rendering, command registration) — it needs your bot token and server. No real provider is integrated or tested.
