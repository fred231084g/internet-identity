/**
 * The identities this Home Screen app delivers for, which only the canister can name.
 *
 * Empty where its record is gone and where it never had one, which the app answers the
 * same way: there is nothing here, and the user is sent back to their browser.
 *
 * The caller brings the actor, so the same question is asked from the page and from the
 * worker. That is the whole of this module: it holds nothing of the document's, so it
 * loads in a worker where there is no `document` to read.
 */
import type { ActorSubclass } from "@icp-sdk/core/agent";
import type { _SERVICE } from "$lib/generated/internet_identity_types";

export const appAnchors = async (
  actor: ActorSubclass<_SERVICE>,
): Promise<bigint[]> =>
  // Candid's `vec nat64` binds as a typed array or a plain one, and a typed array's
  // `map` answers another typed array: a caller turning each anchor into an entry of
  // its own needs a plain array to put them in.
  Array.from(await actor.notification_app_anchors());
