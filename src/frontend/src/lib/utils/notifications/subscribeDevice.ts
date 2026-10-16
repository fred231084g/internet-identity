// Subscribes this browser to push and registers it with the canister: a fresh
// VAPID key, a signed JWT pool, then set_webpush_subscription. The signing key
// is kept (see vapidKeyStore) so the pool can be refreshed later without a new
// subscription. Shared by opt-in, the settings toggle, and the reconcile pass.

import { isCanisterError, throwCanisterError } from "$lib/utils/utils";
import { millisToNanos } from "$lib/utils/time";
import { generateVapidKeypair, signJwtPool } from "./vapidPool";
import {
  currentDeviceSubscription,
  relayOriginOf,
  subscribeToPush,
} from "./pushSubscription";
import {
  loadVapidKey,
  storeVapidKey,
  type StoredVapidKey,
} from "./vapidKeyStore";
import { browserKeyActor } from "./browserActor";
import type { ActorSubclass } from "@icp-sdk/core/agent";
import type {
  _SERVICE,
  SetWebPushSubscriptionError,
} from "$lib/generated/internet_identity_types";

/**
 * Registers a subscription this browser already holds with `identityNumber`, signing a
 * fresh pool with the key it was minted under.
 *
 * The subscription and its VAPID key belong to the browser, not to one identity, so a
 * second identity signing in here registers what is already there. Rotating instead
 * would unsubscribe the endpoint every other identity's row still names.
 */
export const registerStoredDevice = async (
  identityNumber: bigint,
  { endpoint, privateKey, publicKeyRaw }: StoredVapidKey,
  /** Who to call as. The Home Screen app signs as itself, and what it registers lands on
   *  its own record rather than on this identity's entry: the canister decides that from
   *  who the caller turns out to be. Everyone else signs as the browser key this sign-in
   *  registered. */
  caller?: ActorSubclass<_SERVICE>,
): Promise<string> => {
  const issuedAtNs = millisToNanos(Date.now());
  const signatures = await signJwtPool(
    privateKey,
    relayOriginOf(endpoint),
    issuedAtNs,
  );
  const actor = caller ?? (await browserKeyActor(identityNumber));
  await actor
    .set_webpush_subscription({
      anchor_number: identityNumber,
      endpoint,
      vapid_public_key: publicKeyRaw,
      jwt_signatures: signatures,
      jwt_issued_at_ns: issuedAtNs,
    })
    .then(throwCanisterError);
  return endpoint;
};

/**
 * Mints a subscription and a VAPID key for this browser, then registers it. Assumes
 * notification permission is already granted. `subscribeToPush` drops any prior
 * subscription, so this replaces one rather than adding to it, and every other
 * identity's stored row is left naming an endpoint that is gone: only call it where
 * the browser has no usable subscription of its own.
 */
export const subscribeAndRegisterDevice = async (
  identityNumber: bigint,
): Promise<string> => {
  const { publicKeyRaw, privateKey } = await generateVapidKeypair();
  const endpoint = await subscribeToPush(publicKeyRaw);
  const stored = { endpoint, privateKey, publicKeyRaw };
  await registerStoredDevice(identityNumber, stored);
  await storeVapidKey(stored);
  return endpoint;
};

/**
 * The subscription this browser registers with: the one it already holds where the key
 * we kept still names it, and a fresh one otherwise.
 *
 * `minted` says which, because a fresh key belongs on disk only once the canister has
 * taken the endpoint it was made for. Minting is kept apart from registering so that a
 * caller making several registering attempts mints at most one subscription: each mint
 * drops the endpoint the one before it handed out.
 */
const deviceSubscription = async (): Promise<{
  subscription: StoredVapidKey;
  minted: boolean;
}> => {
  const stored = await loadVapidKey();
  const live = await currentDeviceSubscription();
  if (
    stored !== undefined &&
    live !== undefined &&
    stored.endpoint === live.endpoint
  ) {
    return { subscription: stored, minted: false };
  }
  const { publicKeyRaw, privateKey } = await generateVapidKeypair();
  const endpoint = await subscribeToPush(publicKeyRaw);
  return { subscription: { endpoint, privateKey, publicKeyRaw }, minted: true };
};

/**
 * Registers this browser for `identityNumber`, reusing the subscription it already
 * holds. Only a browser without a usable one subscribes afresh, since subscribing
 * drops the endpoint every other identity on this browser is registered with.
 */
export const ensureRegisteredDevice = async (
  identityNumber: bigint,
): Promise<string> => {
  const { subscription, minted } = await deviceSubscription();
  await registerStoredDevice(identityNumber, subscription);
  if (minted) {
    await storeVapidKey(subscription);
  }
  return subscription.endpoint;
};

/**
 * Whether another anchor can still answer the refusal the canister named, over every
 * variant the call's error type carries.
 *
 * `InvalidBrowserKey` is the anchor named not reaching the caller, which says nothing
 * about the next one. `StaleJwtPool` is about the subscription rather than the anchor:
 * the endpoint belongs to this app and is shared by every anchor it serves, so a pool
 * that is not newer than the one that endpoint holds is not newer for any of them, and
 * the anchors after this one would each be refused for the same reason.
 * `InternalCanisterError` names no anchor at all.
 */
const anotherAnchorMayAnswer = (error: unknown): boolean => {
  if (!isCanisterError<SetWebPushSubscriptionError>(error)) {
    return false;
  }
  switch (error.type) {
    case "InvalidBrowserKey":
      return true;
    case "StaleJwtPool":
    case "InternalCanisterError":
      return false;
  }
};

/**
 * Registers `caller`'s subscription under the first of `anchors` the canister accepts
 * it for, answering whether any did.
 *
 * For the Home Screen app, which serves every identity pointing at it and is refused by
 * each one whose reference is switched off or whose browser holds no session. Taking
 * the first anchor alone would let a single such identity end every launch, including
 * the registering that keeps this app's push endpoint current.
 *
 * One subscription for the whole walk. A refusal arrives before anything is stored, so
 * minting per anchor would hand out a new endpoint for each one and leave the app
 * registered at an address the push service has already replaced.
 */
export const registerForAnyAnchor = async (
  anchors: bigint[],
  caller: ActorSubclass<_SERVICE>,
): Promise<boolean> => {
  const { subscription, minted } = await deviceSubscription();
  for (const anchor of anchors) {
    try {
      await registerStoredDevice(anchor, subscription, caller);
    } catch (error) {
      if (anotherAnchorMayAnswer(error)) {
        continue;
      }
      throw error;
    }
    if (minted) {
      await storeVapidKey(subscription);
    }
    return true;
  }
  return false;
};
