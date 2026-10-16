import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clear } from "idb-keyval";

/** Lets one test make storage refuse to answer, which is the whole of what separates
 *  "this app has no key" from "this app could not be asked". */
const storage = vi.hoisted(() => ({ readsFail: false }));

vi.mock("idb-keyval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("idb-keyval")>();
  return {
    ...actual,
    get: (...args: Parameters<typeof actual.get>) =>
      storage.readsFail
        ? Promise.reject(new Error("storage is closed"))
        : actual.get(...args),
  };
});

const { APP_KEY_STORE, appPublicKey, ensureAppKey, readAppKey } =
  await import("./notificationAppKey");

beforeEach(async () => {
  storage.readsFail = false;
  await clear(APP_KEY_STORE);
});

describe("readAppKey", () => {
  it("says there is no key before this app has ever run", async () => {
    await expect(readAppKey()).resolves.toEqual({ kind: "no-key" });
  });

  it("gives back the key this app was minted with", async () => {
    const minted = await ensureAppKey();

    const stored = await readAppKey();

    expect(stored).toEqual({ kind: "key", record: minted });
  });

  /** The two answers send a caller in opposite directions, so they must not arrive as
   *  the same value. */
  it("keeps storage refusing to answer apart from having no key", async () => {
    await ensureAppKey();
    storage.readsFail = true;

    await expect(readAppKey()).resolves.toEqual({
      kind: "unreadable",
      reason: "storage is closed",
    });
  });
});

describe("ensureAppKey", () => {
  it("mints a key the first time this app runs, and keeps it", async () => {
    const first = await ensureAppKey();

    await expect(ensureAppKey()).resolves.toEqual(first);
  });

  /** A key minted over a read that merely failed is a second permanent name for an app
   *  the canister already has links to, and only a reinstall recovers from that. */
  it("refuses to mint over a read that failed", async () => {
    await ensureAppKey();
    storage.readsFail = true;

    await expect(ensureAppKey()).rejects.toThrow("storage is closed");
  });
});

describe("appPublicKey", () => {
  /**
   * The key is this app's name to the canister, which parses what is registered as an
   * SPKI point and verifies the app's calls against it. Exporting anything else registers
   * a name nothing the app signs can be matched to.
   */
  it("gives out the public half in the encoding the canister parses", async () => {
    const record = await ensureAppKey();
    const message = new TextEncoder().encode("the app signs this");
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      record.keyPair.privateKey,
      message,
    );

    const spki = await appPublicKey(record);

    const verifying = await crypto.subtle.importKey(
      "spki",
      new Uint8Array(spki),
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    await expect(
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verifying,
        signature,
        message,
      ),
    ).resolves.toBe(true);
  });
});
