/**
 * The key a Home Screen app carries notifications under.
 *
 * Separate from `browser-key.store.ts`, which holds the key a browser signs in with:
 * that key rotates at every sign-in and is kept per identity, while this one never signs
 * in and never rotates, because the only thing it can do is set and read one push
 * subscription. A Home Screen app also has its own storage partition, so it could not
 * reach the other store even if the semantics matched.
 *
 * Storage only. The service worker reads this to know who it can sign for, and a worker
 * that reached `$lib/globals` from here would pull the page's DOM-bound modules into a
 * context that has no `document`.
 */
import { createStore, get as idbGet, set as idbSet } from "idb-keyval";

/** Exported so a test wipes the store this writes to rather than naming it a second
 *  time, which would let the two names drift apart. */
export const APP_KEY_STORE = createStore("ii-notification-app", "key");
const RECORD_KEY = "key";

export interface AppKeyRecord {
  keyPair: CryptoKeyPair;
}

/**
 * What this app's storage says about the key it runs under.
 *
 * `unreadable` is not `no-key`. This key is the app's only name to the canister, so a
 * caller that reads a storage failure as "there is no app here" acts for an app that
 * exists: it mints a second permanent name, or signs for nobody, or decides it is not
 * the Home Screen app at all. Each caller has to say what it does when it cannot tell.
 */
export type StoredAppKey =
  | { kind: "key"; record: AppKeyRecord }
  | { kind: "no-key" }
  | { kind: "unreadable"; reason: string };

export const readAppKey = async (): Promise<StoredAppKey> => {
  try {
    const record = await idbGet<AppKeyRecord>(RECORD_KEY, APP_KEY_STORE);
    return record === undefined ? { kind: "no-key" } : { kind: "key", record };
  } catch (error) {
    return {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * The key this app has, generating one the first time it runs.
 *
 * Non-extractable, like the browser key: it is the app's name to the canister, and a
 * copy taken off disk would be able to read and replace this app's subscription.
 */
export const ensureAppKey = async (): Promise<AppKeyRecord> => {
  const stored = await readAppKey();
  switch (stored.kind) {
    case "key":
      return stored.record;
    case "unreadable":
      // Minting here would give this app a second permanent name while the canister's
      // links still point at the first, which shows up as an app that is connected to
      // nothing and that only a reinstall recovers.
      throw new Error(`the app key could not be read: ${stored.reason}`);
    case "no-key": {
      const keyPair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      const record: AppKeyRecord = { keyPair };
      await idbSet(RECORD_KEY, record, APP_KEY_STORE);
      return record;
    }
  }
};

export const appPublicKey = (record: AppKeyRecord): Promise<Uint8Array> =>
  crypto.subtle
    .exportKey("spki", record.keyPair.publicKey)
    .then((spki) => new Uint8Array(spki));
