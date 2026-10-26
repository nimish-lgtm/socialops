/**
 * Capability per connected account, not per persona. verified=false rows come from secondary sources
 * and must be checked against the platform's own developer docs before launch (docs/FACTS.md).
 */
export type Route = 'E' | 'A' | 'N';
export interface Capability { route: Route; note: string; verified: boolean }

export const MATRIX: Record<string, Capability> = {
  'instagram:account:professional': { route: 'E', note: 'Business or Creator account via official API', verified: false },
  'facebook:page:page': { route: 'E', note: 'Page you manage via official API', verified: false },
  'instagram:account:personal': { route: 'A', note: 'API cannot post to personal accounts; you post it yourself', verified: false },
  'facebook:profile:personal': { route: 'A', note: 'No API posting to personal profiles; you post it yourself', verified: false },
};

export function capabilityFor(platform: string, surface: string, accountType: string): Capability {
  return MATRIX[`${platform}:${surface}:${accountType}`] ?? { route: 'N', note: 'Unsupported combination', verified: false };
}
