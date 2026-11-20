// Staff hierarchy and capability checks. Pure functions: easy to test.
export const LEVELS = { owner: 100, admin: 80, senior: 60, middleman: 40, support: 20, trial: 10 };
export const LABELS = { owner: 'Owner', admin: 'Administrator', senior: 'Senior Middleman', middleman: 'Middleman', support: 'Support', trial: 'Trial Staff' };
export const CAPS = {
  'ticket.handle': 10, 'dispute.review': 20, 'history.view': 20, 'deal.claim': 40,
  'deal.cancel': 60, 'activity.view': 60, 'panel.post': 80, 'simulate': 80, 'audit.verify': 80, 'backup': 80, 'wallet': 100, 'refund': 100,
};

/** Highest staff role for a set of Discord role IDs. */
export function staffRole(roleIds, roles, { isGuildOwner = false } = {}) {
  const have = new Set(roleIds);
  if (isGuildOwner) return 'owner';
  let best = null;
  for (const [name, ids] of Object.entries(roles)) {
    if (ids.some((i) => have.has(i)) && (!best || LEVELS[name] > LEVELS[best])) best = name;
  }
  return best;
}
export const can = (role, cap) => !!role && LEVELS[role] >= CAPS[cap];
