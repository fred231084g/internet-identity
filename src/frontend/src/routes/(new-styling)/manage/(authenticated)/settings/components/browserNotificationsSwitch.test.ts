import { beforeEach, describe, expect, it, vi } from "vitest";
// The permission prompt, the registration and this browser's own storage, which is
// what these two orchestrate: what is under test is which of them they ask, in what
// order, and what is left behind when one of them refuses.
vi.mock("$lib/utils/notifications/pushSubscription", () => ({
  requestNotificationPermission: vi.fn(),
}));
vi.mock("$lib/utils/notifications/subscribeDevice", () => ({
  ensureRegisteredDevice: vi.fn(),
}));
vi.mock("$lib/utils/notifications/turnedOff", () => ({
  clearNotificationsOff: vi.fn(),
  recordNotificationsOff: vi.fn(),
}));

import type { ActorSubclass } from "@icp-sdk/core/agent";
import type { _SERVICE } from "$lib/generated/internet_identity_types";
import { requestNotificationPermission } from "$lib/utils/notifications/pushSubscription";
import { ensureRegisteredDevice } from "$lib/utils/notifications/subscribeDevice";
import {
  clearNotificationsOff,
  recordNotificationsOff,
} from "$lib/utils/notifications/turnedOff";
import {
  turnOffInBrowser,
  turnOnInBrowser,
} from "./browserNotificationsSwitch";

const IDENTITY = BigInt(10_000);
const BROWSER_ID = 7;

const permission = vi.mocked(requestNotificationPermission);
const register = vi.mocked(ensureRegisteredDevice);
const clearWord = vi.mocked(clearNotificationsOff);
const recordWord = vi.mocked(recordNotificationsOff);

/** The identity's own actor, answering `reply` to the one call this makes. */
const actorAnswering = (
  reply: Awaited<ReturnType<_SERVICE["remove_webpush_subscription"]>>,
) => {
  const remove_webpush_subscription = vi.fn(() => Promise.resolve(reply));
  return {
    actor: {
      remove_webpush_subscription,
    } as unknown as ActorSubclass<_SERVICE>,
    remove: remove_webpush_subscription,
  };
};

const ok = { Ok: null } as const;

/** The press, against the actor each case set up to answer it. */
const turnOff = (actor: ActorSubclass<_SERVICE>) =>
  turnOffInBrowser({ identityNumber: IDENTITY, browserId: BROWSER_ID, actor });

describe("turnOnInBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permission.mockResolvedValue("granted");
    clearWord.mockResolvedValue(undefined);
    register.mockResolvedValue("https://push.example/endpoint");
  });

  it("takes back the word before it registers", async () => {
    await expect(turnOnInBrowser(IDENTITY)).resolves.toBe("delivering");

    expect(clearWord).toHaveBeenCalledWith(IDENTITY);
    expect(register).toHaveBeenCalledWith(IDENTITY);
    expect(clearWord.mock.invocationCallOrder[0]).toBeLessThan(
      register.mock.invocationCallOrder[0],
    );
  });

  /** A refusal cannot be asked again from here: the site has to be allowed in the
   *  browser's own settings, which is what the switch says. */
  it("registers nothing where the prompt was refused", async () => {
    permission.mockResolvedValue("denied");

    await expect(turnOnInBrowser(IDENTITY)).resolves.toBe("permission-refused");
    expect(clearWord).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  /** A prompt closed without an answer leaves the permission at `default`, which is
   *  still not a browser that can hold a subscription. */
  it("registers nothing where the prompt was closed", async () => {
    permission.mockResolvedValue("default");

    await expect(turnOnInBrowser(IDENTITY)).resolves.toBe("permission-refused");
    expect(register).not.toHaveBeenCalled();
  });

  /** Registering on top of a word that is still stored leaves a browser that delivers
   *  and every later reconcile told to leave it alone. */
  it("registers nothing where the word could not be taken back", async () => {
    clearWord.mockRejectedValue(new Error("storage is blocked"));

    await expect(turnOnInBrowser(IDENTITY)).rejects.toThrow(
      "storage is blocked",
    );
    expect(register).not.toHaveBeenCalled();
  });
});

describe("turnOffInBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordWord.mockResolvedValue(undefined);
  });

  it("names this browser's own entry", async () => {
    const { actor, remove } = actorAnswering(ok);

    await turnOff(actor);

    expect(remove).toHaveBeenCalledWith({
      anchor_number: IDENTITY,
      browser_id: BROWSER_ID,
    });
  });

  it("drops the registration before it stores the word", async () => {
    const { actor, remove } = actorAnswering(ok);

    await turnOff(actor);

    expect(recordWord).toHaveBeenCalledWith(IDENTITY);
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(
      recordWord.mock.invocationCallOrder[0],
    );
  });

  /**
   * The word stored for a subscription that is still live is the one failure nothing
   * here gets out of: the switch would report off, notifications would keep arriving,
   * and every later reconcile would read the word and leave the registration alone.
   */
  it("stores no word where the canister kept the registration", async () => {
    const { actor } = actorAnswering({
      Err: { InternalCanisterError: "the subnet is busy" },
    });

    await expect(turnOff(actor)).rejects.toThrow();
    expect(recordWord).not.toHaveBeenCalled();
  });

  /** The registration is gone and nothing says it should stay gone, which the next
   *  reconcile undoes by registering again. The switch says so meanwhile. */
  it("reports a word it could not store", async () => {
    const { actor, remove } = actorAnswering(ok);
    recordWord.mockRejectedValue(new Error("storage is full"));

    await expect(turnOff(actor)).rejects.toThrow("storage is full");
    expect(remove).toHaveBeenCalledOnce();
  });
});
