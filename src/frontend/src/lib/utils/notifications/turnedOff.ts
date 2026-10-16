/**
 * This identity's word that notifications are off in this browser.
 *
 * Dropping the registration is not enough on its own: the reconcile on the next
 * authenticated boot registers this browser again wherever its subscription is sound,
 * and delivery would come back without the user asking for it. So the switch leaves
 * this behind and the reconcile reads it.
 *
 * Per identity, because the subscription belongs to the browser: every other identity
 * signed in here delivers through the same one, and unsubscribing would take theirs
 * away too.
 *
 * Which way each failure falls is the whole point of this file. A storage that cannot
 * be read reads as off, because a reconcile that does not run is something the user can
 * undo by turning the switch back on, while notifications arriving on a phone that
 * refused them is not. A storage that cannot be written throws, because a switch that
 * reports off while nothing was stored is the same resurrection one boot later.
 */
import {
  createStore,
  del as idbDel,
  get as idbGet,
  set as idbSet,
} from "idb-keyval";

const TURNED_OFF_STORE = createStore(
  "ii-notification-turned-off",
  "turned-off",
);

/** Throws where it could not be stored, so the switch can say it did not take. */
export const recordNotificationsOff = (identityNumber: bigint): Promise<void> =>
  idbSet(identityNumber.toString(), true, TURNED_OFF_STORE);

/** Answers `true` where this browser could not be read: what cannot be known is
 *  treated as the answer the user cannot undo. */
export const notificationsTurnedOff = async (
  identityNumber: bigint,
): Promise<boolean> => {
  try {
    return (
      (await idbGet<boolean>(identityNumber.toString(), TURNED_OFF_STORE)) ===
      true
    );
  } catch (error) {
    // Which way this falls is deliberate, so the reason it fell that way is worth
    // having: a reconcile skipped for a storage that cannot be read looks from the
    // outside exactly like one skipped because the user asked for it.
    console.error(error);
    return true;
  }
};

/** Forgets it, so the reconcile keeps this browser registered again. Throws where it
 *  could not be forgotten, which leaves the switch reporting what happened. */
export const clearNotificationsOff = (identityNumber: bigint): Promise<void> =>
  idbDel(identityNumber.toString(), TURNED_OFF_STORE);
