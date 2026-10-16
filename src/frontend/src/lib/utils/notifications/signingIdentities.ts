/**
 * Who the storage of this origin can sign for.
 *
 * Notifications are a browser's, not an identity's: what reaches the user is whatever
 * the document they arrive in can prove it is. A browser keeps a key per identity, so
 * it answers one entry per identity that has signed in here; a Home Screen app's
 * partition holds a single key for the single entry it claimed. Both are browser
 * entries to the canister, and both are read the same way.
 *
 * The anchor number comes along with the key because it has to: a browser call names the
 * anchor it is for, and the canister resolves the caller inside it rather than finding it
 * from the key. An app's calls about itself name none, but the ones about notifications
 * do, which is why the app answers one entry per identity it serves.
 */
import type { SignIdentity } from "@icp-sdk/core/agent";
import { ECDSAKeyIdentity } from "@icp-sdk/core/identity";
import {
  browserKeyIdentity,
  registeredIdentityNumbers,
} from "$lib/stores/browser-key.store";
import { readAppKey, type AppKeyRecord } from "./notificationAppKey";
import { appKeyActorWith } from "./notificationAppActor";
import { appAnchors } from "./appAnchors";
import { config } from "./workerConfig";
import { Principal } from "@icp-sdk/core/principal";

export interface SigningIdentity {
  identityNumber: bigint;
  identity: SignIdentity;
}

const fromBrowserKeys = async (): Promise<SigningIdentity[]> => {
  const identityNumbers = await registeredIdentityNumbers();
  const entries = await Promise.all(
    identityNumbers.map(async (identityNumber) => {
      const identity = await browserKeyIdentity(identityNumber).catch(
        () => undefined,
      );
      return identity === undefined ? [] : [{ identityNumber, identity }];
    }),
  );
  return entries.flat();
};

/** The identities pointing at this app, which only the canister can name. Rejects where
 *  the canister could not be reached, or where the worker was told nothing to reach, as
 *  a document with no config is. */
const claimedAnchors = async (record: AppKeyRecord): Promise<bigint[]> => {
  const actor = await appKeyActorWith(record, {
    agentOptions: config.agentOptions,
    canisterId: Principal.fromText(config.canisterId),
  });
  return appAnchors(actor);
};

const fromAppKey = async (): Promise<SigningIdentity[]> => {
  const stored = await readAppKey();
  switch (stored.kind) {
    case "no-key":
      return [];
    case "unreadable":
      // Not the same as being no app: the key may be sitting there behind a store that
      // would not open, and signing for nobody would leave the user with the browser's
      // own "updated in the background" notice in place of what actually arrived.
      throw new Error(`the app key could not be read: ${stored.reason}`);
    case "key": {
      const identity = await ECDSAKeyIdentity.fromKeyPair(
        stored.record.keyPair,
      );
      // One key, one entry per identity, and the canister is the only party that can
      // name them: a browser can point another identity at this app while it is not
      // running, and nothing in this storage would hear about it.
      //
      // An answer that did not arrive is reported rather than read as an empty list, for
      // the reason the `unreadable` arm above gives: signing for nobody is the outcome
      // that leaves the user with the browser's own "updated in the background" notice,
      // and a canister that could not be reached must not reach it silently.
      const anchors = await claimedAnchors(stored.record);
      return anchors.map((identityNumber) => ({ identityNumber, identity }));
    }
  }
};

/**
 * Every entry this storage holds a key for.
 *
 * Empty where nothing has signed in and no app has been claimed, which is a document
 * with nothing to ask the canister rather than an error. Anything that went wrong is
 * reported rather than folded into that emptiness, whether it is a store that would not
 * open or a canister that did not answer: the two keys live in stores of their own, so
 * one failing says nothing about the other and the entries that did answer are still
 * worth having.
 */
export const signingIdentities = async (): Promise<SigningIdentity[]> => {
  const [browsers, app] = await Promise.all([
    fromBrowserKeys().catch((error: unknown) => {
      console.error(error);
      return [];
    }),
    fromAppKey().catch((error: unknown) => {
      console.error(error);
      return [];
    }),
  ]);
  return [...browsers, ...app];
};
