import { EmbedBuilder } from 'discord.js';
import { BRAND } from './ui.js';

const chan = (id, fallback) => (id ? `<#${id}>` : fallback);

export function welcomePayload(cfg, user) {
  const e = new EmbedBuilder().setColor(BRAND.blue)
    .setTitle('Welcome to Nexora Hub')
    .setDescription([
      `Welcome <@${user.id}>! **Nexora Hub** is a safe, automated **crypto middleman** for Roblox trades.`,
      '',
      `**1. Read the rules** in ${chan(cfg.channels.rules, '**#rules**')}. Every trader must follow them.`,
      `**2. Start a deal** in ${chan(cfg.channels.panel, '**the auto MM channel**')}. Pick your coin and the bot walks you through it.`,
      '',
      '**Stay safe:** staff and the bot will **never DM you first** and will **never ask** for your password, 2FA code or seed phrase.',
    ].join('\n'))
    .setThumbnail(user.displayAvatarURL?.({ size: 256 }) ?? null);
  return { content: `<@${user.id}>`, embeds: [e], allowedMentions: { users: [user.id] } };
}

export async function sendWelcome(ctx, member) {
  if (member.user?.bot) return;
  const id = ctx.cfg.channels.welcome; if (!id) return;
  const ch = await ctx.client.channels.fetch(id).catch(() => null); if (!ch?.send) return;
  await ch.send(welcomePayload(ctx.cfg, member.user));
}
