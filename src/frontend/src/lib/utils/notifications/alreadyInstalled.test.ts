import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clear } from "idb-keyval";

/** Lets one test make storage refuse, which is the whole of what both of these have to
 *  survive: a browser that will not answer must not end the launch. */
const storage = vi.hoisted(() => ({ fails: false }));

vi.mock("idb-keyval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("idb-keyval")>();
  const refuse = () => Promise.reject(new Error("storage is closed"));
  return {
    ...actual,
    get: (...args: Parameters<typeof actual.get>) =>
      storage.fails ? refuse() : actual.get(...args),
    set: (...args: Parameters<typeof actual.set>) =>
      storage.fails ? refuse() : actual.set(...args),
  };
});

const {
  ALREADY_INSTALLED_STORE,
  recordAlreadyInstalled,
  saidAlreadyInstalled,
} = await import("./alreadyInstalled");

const IDENTITY = BigInt(10_000);
const OTHER = BigInt(20_000);

beforeEach(async () => {
  storage.fails = false;
  vi.restoreAllMocks();
  await clear(ALREADY_INSTALLED_STORE);
});

describe("saidAlreadyInstalled", () => {
  it("says nothing was said before the user is asked", async () => {
    await expect(saidAlreadyInstalled(IDENTITY)).resolves.toBe(false);
  });

  it("gives back what this browser was told", async () => {
    await recordAlreadyInstalled(IDENTITY);

    await expect(saidAlreadyInstalled(IDENTITY)).resolves.toBe(true);
  });

  /// An app is linked under one identity, so another identity in this browser has no
  /// app and is still owed the install.
  it("keeps one identity's answer from answering for another", async () => {
    await recordAlreadyInstalled(IDENTITY);

    await expect(saidAlreadyInstalled(OTHER)).resolves.toBe(false);
  });

  /**
   * Offering the install again is where this started and is survivable. Reaching the
   * caller as a throw is not: the read sits on the path that decides the whole screen.
   */
  it("offers the install again where storage refuses to answer", async () => {
    const reported = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await recordAlreadyInstalled(IDENTITY);
    storage.fails = true;

    await expect(saidAlreadyInstalled(IDENTITY)).resolves.toBe(false);
    expect(reported).toHaveBeenCalledOnce();
  });
});

describe("recordAlreadyInstalled", () => {
  /// The user has told us about an app nothing here can see, and a throw would land them
  /// on a failure screen for an answer that was taken fine.
  it("carries on where storage refuses the write", async () => {
    const reported = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    storage.fails = true;

    await expect(recordAlreadyInstalled(IDENTITY)).resolves.toBeUndefined();
    expect(reported).toHaveBeenCalledOnce();
  });
});
