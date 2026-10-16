/**
 * What Internet Identity's own notifications say.
 *
 * The canister sends the event rather than the sentence: the words belong here, where
 * the translations are, and rewording one costs no canister upgrade. It carries no text
 * for the same reason an app's notification carries none, which is that nothing of the
 * user's goes through the push service.
 */
import type { NotificationEvent } from "$lib/generated/internet_identity_types";

/** Fails this build where the canister's type gains a variant, so the words for it are
 *  written here rather than discovered on a phone. */
const noWordsWrittenFor = (event: never): void => void event;

export const identityNotificationText = (
  event: NotificationEvent,
): { title: string; body: string } => {
  if ("NotificationsOn" in event) {
    const { anchor_number, name } = event.NotificationsOn;
    // Named, because nobody recognises an identity by its number. The number is what is
    // left when the user has not named it.
    const identity = name[0] ?? `identity ${anchor_number}`;
    return {
      title: "Notifications are on",
      body: `This device now receives notifications for ${identity}.`,
    };
  }
  // The assertion and the sentence both, not one in place of the other. The assertion is
  // what this build pays for a variant added to the type, so the words for it are written
  // here. The sentence is what a build older than the canister owes the user: the
  // notification was woken for, and a worker that shows nothing is one the browser
  // answers for.
  noWordsWrittenFor(event);
  return {
    title: "Internet Identity",
    body: "Something about your identity changed.",
  };
};
