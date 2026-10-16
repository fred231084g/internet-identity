/**
 * Pointing this identity at the Home Screen app another identity on this browser has.
 *
 * The app is one thing on the device and delivers for every identity pointing at it, but
 * nothing here can reach it: it runs in a storage partition no browser can read. What
 * can reach both is this browser, which holds a key per identity signed in on it. So an
 * identity that has the app signs a token naming the identity being added, which spends
 * it in the same call, and the app is not involved at all: it is installed, it has its
 * record, and it is already registered for push, so delivery starts the moment the
 * pointing is written.
 */
import type { ClaimNotificationAppError } from "$lib/generated/internet_identity_types";
import {
  registeredIdentityNumbers,
  signNotificationAppClaim,
} from "$lib/stores/browser-key.store";
import {
  isCanisterError,
  throwCanisterError,
  type CanisterError,
} from "$lib/utils/utils";
import { browserKeyActor } from "./browserActor";
import { LINK_TOKEN_LIFETIME_MS } from "./linkToken";

/**
 * What a refusal was, in the canister's own words.
 *
 * Every arm the variant carries, so an arm added to it is a compile error here rather
 * than a refusal that reaches the log saying nothing: `CanisterError` is constructed
 * with no message, so its own is empty.
 */
const refusal = (error: CanisterError<ClaimNotificationAppError>): string => {
  switch (error.type) {
    case "InvalidBrowserKey":
    case "InvalidClaimToken":
    case "ClaimTokenExpired":
    case "NoNotificationApp":
      return error.type;
    case "InternalCanisterError":
      return `${error.type}: ${error.value("InternalCanisterError")}`;
  }
};

/** Why a claim did not happen, which for a refusal is the variant the canister sent and
 *  for anything else is what the browser or the transport said. */
const describe = (error: unknown): string => {
  if (isCanisterError<ClaimNotificationAppError>(error)) {
    return refusal(error);
  }
  return error instanceof Error ? error.message : String(error);
};

/**
 * Asks `offeringIdentityNumber` for a token and spends it, answering whether the
 * canister wrote the pointing and naming in the log why it did not.
 *
 * The token is signed by the offering identity's own browser key, which is the key the
 * canister keeps as that entry's successor, and it names both anchors and an expiry: it
 * is good for this pair alone and only for as long as the claim takes.
 */
const claimFrom = async (
  identityNumber: bigint,
  offeringIdentityNumber: bigint,
): Promise<boolean> => {
  // The link token's window, which is the one the canister bounds both tokens against.
  const expiresAtNs =
    BigInt(Date.now() + LINK_TOKEN_LIFETIME_MS) * BigInt(1_000_000);
  try {
    const signature = await signNotificationAppClaim({
      offeringIdentityNumber,
      claimingIdentityNumber: identityNumber,
      expiresAtNs,
    });
    if (signature === undefined) {
      // No sign-in has placed this identity's key in an entry, so it would sign a token
      // for an entry the canister cannot find and has nothing to hand over.
      console.warn(
        `anchor ${offeringIdentityNumber} is not registered as a browser here`,
      );
      return false;
    }
    const actor = await browserKeyActor(identityNumber);
    await actor
      .claim_notification_app({
        anchor_number: identityNumber,
        offering_anchor_number: offeringIdentityNumber,
        expires_at_ns: expiresAtNs,
        signature,
      })
      .then(throwCanisterError);
    return true;
  } catch (error) {
    console.warn(
      `the app of anchor ${offeringIdentityNumber} was not claimed: ${describe(error)}`,
    );
    return false;
  }
};

/**
 * Points `identityNumber` at the app this device already has, where another identity on
 * this browser can hand it over.
 *
 * Answers whether the canister wrote the pointing. `false` is not a failure: it is a
 * device whose app nothing here can vouch for, and the install is what is offered
 * instead.
 *
 * One call per candidate and no more. What a refusal says is about the identity it came
 * from, so the next one is asked; asking the same one again would get the same answer,
 * since making a claim consumes nothing and a second one writes the same pointing.
 */
export const claimDeviceApp = async (
  identityNumber: bigint,
): Promise<boolean> => {
  let offering: bigint[];
  try {
    offering = (await registeredIdentityNumbers()).filter(
      (other) => other !== identityNumber,
    );
  } catch (error) {
    // Not an answer about this device. The identities that could hand their app over
    // are sitting behind a store that would not open, and reading that as none of them
    // having one sends the user to install the app they already have.
    console.error(error);
    return false;
  }
  if (offering.length === 0) {
    console.warn("no other identity is signed in here to hand an app over");
    return false;
  }
  for (const offeringIdentityNumber of offering) {
    if (await claimFrom(identityNumber, offeringIdentityNumber)) {
      return true;
    }
  }
  return false;
};
