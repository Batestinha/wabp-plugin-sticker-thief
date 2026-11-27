import { memberSubscriptionService, registerMemberSubscription, type MemberSubscription } from '@wabs/plugin-sdk/member-subscriptions';
import { isCadence } from './constants';
import { configFor, nowFrom, scheduleDigest, startBackfill, stickerDatabase, type StickerThiefDeps } from './service';
import { deleteSubscription, getSubscription, upsertSubscription } from './store';

const ns = 'official.sticker-thief';
export const digestOffer: MemberSubscription = { id: 'digest', kind: 'internal', scope: 'current',
  labelKey: ns + '.subscription.title', serviceId: ns + '.subscriptions.v1',
  choices: ['off', 'daily', 'weekly'].map(id => ({ id, labelKey: ns + '.subscription.' + id })) };
export const digestService = memberSubscriptionService(digestOffer);

export async function digestPreference(deps: StickerThiefDeps, scope: string, id: string, choice?: string) {
  const db = stickerDatabase(deps);
  if (!db || !(await configFor(deps, scope, id)).enabled) return null;
  const current = getSubscription(db, scope, id);
  if (choice === 'off') {
    if (current) deleteSubscription(db, scope, id);
    return { choice, changed: Boolean(current) };
  }
  if (choice === undefined) return { choice: current?.cadence ?? 'off', changed: false };
  if (!isCadence(choice)) throw new Error('Unknown digest cadence.');
  const subscription = current?.cadence === choice ? current : upsertSubscription(db, scope, id, choice, nowFrom(deps));
  await scheduleDigest(deps, subscription);
  await startBackfill(deps, scope, { onlyFirstTime: true });
  return { choice, changed: current?.cadence !== choice };
}
export function digestRegistration(deps: StickerThiefDeps) {
  async function preference(scope: string, id: string, choice?: string) {
    const state = await digestPreference(deps, scope, id, choice);
    return state && { choice: state.choice };
  }
  return registerMemberSubscription(digestOffer, c => preference(c.scopeId, c.actorIdentityId!),
    (c, choice) => preference(c.scopeId, c.actorIdentityId!, choice));
}
