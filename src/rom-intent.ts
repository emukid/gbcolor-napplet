import { decode } from 'nostr-tools/nip19';

export const ROM_LOAD_CONVENTION = 'napplet:gameboy/load';

export function parseRomIntent(payload: unknown) {
  if (!payload || typeof payload !== 'object' || !('naddr' in payload) || typeof payload.naddr !== 'string') {
    throw new Error('Load ROM intent requires an naddr');
  }
  const value = payload.naddr.trim();
  if (!value.startsWith('naddr1') || value.length > 8192) throw new Error('Invalid ROM naddr');
  let decoded;
  try { decoded = decode(value); }
  catch { throw new Error('Invalid ROM naddr'); }
  if (decoded.type !== 'naddr' || decoded.data.kind !== 32560 || !decoded.data.identifier) {
    throw new Error('ROM naddr must reference a kind 32560 ROM');
  }
  return decoded.data;
}

export const GAMEBOY_COMMANDS = ['open', 'browse', 'settings', 'pause', 'resume', 'sound', 'maximize'] as const;
export type GameboyCommand = {
  action: typeof GAMEBOY_COMMANDS[number];
  scope?: 'mine' | 'network' | 'global';
  enabled?: boolean;
};

export function parseGameboyCommand(action: GameboyCommand['action'], payload: unknown): GameboyCommand {
  if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload))) {
    throw new Error('Intent payload must be an object');
  }
  const data = (payload ?? {}) as Record<string, unknown>;
  const allowed = action === 'browse' ? ['scope'] : action === 'sound' || action === 'maximize' ? ['enabled'] : [];
  if (Object.keys(data).some(key => !allowed.includes(key))) throw new Error(`Unexpected ${action} intent option`);
  if (action === 'browse') {
    if (data.scope !== undefined && data.scope !== 'mine' && data.scope !== 'network' && data.scope !== 'global') {
      throw new Error('Library scope must be mine, network, or global');
    }
    return { action, scope: data.scope as GameboyCommand['scope'] };
  }
  if (action === 'sound' || action === 'maximize') {
    const value = data.enabled ?? (action === 'maximize' ? true : undefined);
    if (value !== true && value !== false && value !== 'true' && value !== 'false') {
      throw new Error('Intent enabled must be true or false');
    }
    return { action, enabled: value === true || value === 'true' };
  }
  return { action };
}
