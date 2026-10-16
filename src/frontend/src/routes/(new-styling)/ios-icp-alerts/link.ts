/**
 * What the app does on the launch it was installed by: spend the token it carries.
 *
 * The token is the installing browser's signature, and spending it is what gives this
 * app a record of its own and points that browser at it. Nothing else can: the app runs
 * in a storage partition no browser can reach, and the key it signs with is one the
 * canister has never seen before this call.
 */
import {
  type CanisterError,
  isCanisterError,
  throwCanisterError,
} from "$lib/utils/utils";
import {
  appPublicKey,
  type AppKeyRecord,
} from "$lib/utils/notifications/notificationAppKey";
import type { ActorSubclass } from "@icp-sdk/core/agent";
import type {
  _SERVICE,
  LinkNotificationAppError,
} from "$lib/generated/internet_identity_types";
import type { LinkToken } from "$lib/utils/notifications/linkToken";

export type LinkOutcome =
  | { status: "linked" }
  /** The canister refused the token itself, which a fresh one fixes: the user starts the
   *  install again, which is a step they have already seen. */
  | { status: "token-refused"; reason: string }
  /** The canister refused the key this app signs with, which nothing in the app can
   *  replace: a key is minted once per storage partition, so the only fresh one is the
   *  one a fresh install mints. */
  | { status: "key-refused"; reason: string }
  | { status: "failed"; reason: string };

/**
 * What to show for a failure, which for a canister refusal is the variant it carries.
 *
 * `CanisterError` is constructed with no message, so reading `.message` off one yields an
 * empty string and the screen would name no reason at all.
 */
const describe = (error: unknown): string => {
  if (isCanisterError<LinkNotificationAppError>(error)) {
    return String(error.type);
  }
  return error instanceof Error ? error.message : String(error);
};

/**
 * What a refusal the canister named leaves the launch able to do, for every variant the
 * call's error type carries.
 *
 * Exhaustive and without a catch-all, because the two answers that are not failures send
 * the user somewhere a generic failure cannot: a refusal landing in the wrong one ends
 * the launch on a screen whose only offer is to try the same call again.
 */
const refusal = (
  error: CanisterError<LinkNotificationAppError>,
  reason: string,
): LinkOutcome => {
  switch (error.type) {
    // No browser of this identity signed the token, or the one that did has rotated its
    // key past it. Either way a fresh token is signed by a key the canister accepts.
    case "InvalidLinkToken":
    case "LinkTokenExpired":
      return { status: "token-refused", reason };
    // The key this app asks to have linked is one a browser of the identity already
    // signs with, or is not the key the call is signed with. Neither is about the token,
    // and this app has only the one key.
    case "KeyAlreadyInUse":
    case "CallerIsNotTheApp":
      return { status: "key-refused", reason };
    case "InternalCanisterError":
      return { status: "failed", reason };
  }
};

export const linkWithToken = async (
  actor: ActorSubclass<_SERVICE>,
  record: AppKeyRecord,
  token: LinkToken,
): Promise<LinkOutcome> => {
  try {
    await actor
      .link_notification_app({
        anchor_number: token.identityNumber,
        app_key: await appPublicKey(record),
        expires_at_ns: token.expiresAtNs,
        signature: token.signature,
      })
      .then(throwCanisterError);
    return { status: "linked" };
  } catch (error) {
    const reason = describe(error);
    return isCanisterError<LinkNotificationAppError>(error)
      ? refusal(error, reason)
      : { status: "failed", reason };
  }
};
