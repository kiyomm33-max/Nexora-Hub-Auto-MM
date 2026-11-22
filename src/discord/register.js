import { REST, Routes } from 'discord.js';
import { definitions } from './commands.js';
import { loadConfig } from '../config.js';
export async function registerCommands(cfg, { clear = false } = {}) {
  const rest = new REST().setToken(cfg.token);
  const route = cfg.guildId ? Routes.applicationGuildCommands(cfg.clientId, cfg.guildId) : Routes.applicationCommands(cfg.clientId);
  await rest.put(route, { body: clear ? [] : definitions });
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig(); await registerCommands(cfg); console.log(`Registered ${definitions.length} commands`);
}
