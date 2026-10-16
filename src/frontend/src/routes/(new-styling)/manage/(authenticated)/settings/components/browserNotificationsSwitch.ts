/**
 * What the notifications switch does on a device whose notifications arrive in this
 * browser rather than in a Home Screen app.
 *
 * Both halves mutate the one subscription this browser holds, which every identity
 * signed in here delivers through, so the order each half works in is most of what it
 * is: a registration dropped with nothing to stop the next boot putting it back, or a
 * word stored for a registration that is still live, are the two ways the switch ends
 * up lying about what arrives.
 */
import type { ActorSubclass } from "@icp-sdk/core/agent";
import type { _SERVICE } from "$lib/generated/internet_identity_types";
import { throwCanisterError } from "$lib/utils/utils";
import { requestNotificationPermission } from "$lib/utils/notifications/pushSubscription";
import { ensureRegisteredDevice } from "$lib/utils/notifications/subscribeDevice";
import {
  clearNotificationsOff,
  recordNotificationsOff,
} from "$lib/utils/notifications/turnedOff";

/** Notifications reach this browser now, or the permission is what stands in the way
 *  and only the user can lift it, in the browser's own settings. */
export type BrowserSwitchOutcome = "delivering" | "permission-refused";

/**
 * Asks for the permission this browser needs and registers it.
 *
 * Taking back the word that notifications are off goes first, so a storage that refuses
 * it is reported with nothing registered yet. The other order leaves a browser that
 * delivers, a switch reporting that it does not, and a word that every later reconcile
 * reads as a reason to leave the registration alone.
 */
export const turnOnInBrowser = async (
  identityNumber: bigint,
): Promise<BrowserSwitchOutcome> => {
  const permission = await requestNotificationPermission();
  if (permission !== "granted") {
    return "permission-refused";
  }
  await clearNotificationsOff(identityNumber);
  await ensureRegisteredDevice(identityNumber);
  return "delivering";
};

/**
 * Drops this browser's registration and leaves this identity's word that it wants none,
 * which is what keeps the reconcile on the next boot from registering it again.
 *
 * The canister goes first. A storage that refuses the write then leaves a browser that
 * delivers nothing and nothing to stop the next reconcile registering it again, which
 * the user sees and can act on: the switch reports the failure and the next boot puts
 * delivery back. The other order leaves the opposite, which nothing here can get out
 * of: the word is stored, the subscription still delivers, and every later reconcile
 * reads the word and refuses to touch a registration that is still live.
 *
 * The permission is left alone either way: that is the browser's to give and the user's
 * to take back in its settings.
 */
export const turnOffInBrowser = async ({
  identityNumber,
  browserId,
  actor,
}: {
  identityNumber: bigint;
  /** Which of the identity's browsers this one is, as its registration recorded it. */
  browserId: number;
  /** Signed as the identity: the subscription hangs off its own entry, which the
   *  identity owns. */
  actor: ActorSubclass<_SERVICE>;
}): Promise<void> => {
  await actor
    .remove_webpush_subscription({
      anchor_number: identityNumber,
      browser_id: browserId,
    })
    .then(throwCanisterError);
  await recordNotificationsOff(identityNumber);
};
