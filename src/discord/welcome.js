import { ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder, SeparatorBuilder, MediaGalleryBuilder } from 'discord.js';
import { isPaused } from '../core/pause.js';
import { BRAND, lineFile } from './ui.js';

const chan = (id, fallback) => (id ? `<#${id}>` : fallback);
const t = (s) => new TextDisplayBuilder().setContent(s);

export function welcomePayload(cfg, user) {
  const box = new ContainerBuilder().setAccentColor(BRAND.blue)
    .addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(t([
        '## <:Sender:1575262944063787161> Welcome to Nexora Hub',
        `Welcome <@${user.id}>! **Nexora Hub** is a safe, automated **crypto middleman** for Roblox trades.`,
      ].join('\n')))
      .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: 'https://cdn.discordapp.com/emojis/1575069932130140220.png?size=128' } })))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(t([
      `**<:aaaaaaaaaaaaa:1575248196471492618> 1. Read the rules**\nin ${chan(cfg.channels.rules, '**#rules**')}. Every trader must follow them.`,
      '',
      `**<:cube:1575100667901648968> 2. Start a deal**\nin ${chan(cfg.channels.panel, '**the auto MM channel**')}. Pick your coin and the bot walks you through it.`,
    ].join('\n')))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(t('**Stay safe:** staff and the bot will **never DM you first** and will **never ask** for your password, 2FA code or seed phrase.'))
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems({ media: { url: 'attachment://line.png' } }));
  return { flags: 1 << 15, components: [t(`<@${user.id}>`), box], files: [lineFile()], allowedMentions: { users: [user.id] } };
}

export async function sendWelcome(ctx, member) {
  if (member.user?.bot || (ctx.db && isPaused(ctx.db, 'welcome'))) return;
  const id = ctx.cfg.channels.welcome; if (!id) return;
  const ch = await ctx.client.channels.fetch(id).catch(() => null); if (!ch?.send) return;
  await ch.send(welcomePayload(ctx.cfg, member.user));
}
