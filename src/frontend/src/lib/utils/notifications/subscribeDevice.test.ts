import { beforeEach, describe, expect, it, vi } from "vitest";
// Mocked before the unit is imported: every one of these reaches for a browser
// (IndexedDB, the push manager, WebCrypto) and what is under test is which of
// them the registration decides to use.
vi.mock("./vapidKeyStore", () => ({
  loadVapidKey: vi.fn(),
  storeVapidKey: vi.fn(() => Promise.resolve()),
}));
vi.mock("./pushSubscription", () => ({
  currentDeviceSubscription: vi.fn(),
  relayOriginOf: vi.fn(() => "https://relay.example"),
  subscribeToPush: vi.fn(() => Promise.resolve(FRESH)),
}));
vi.mock("./vapidPool", () => ({
  generateVapidKeypair: vi.fn(() =>
    Promise.resolve({ publicKeyRaw: new Uint8Array([9]), privateKey: {} }),
  ),
  signJwtPool: vi.fn(() => Promise.resolve([new Uint8Array([1])])),
}));
vi.mock("./browserActor", () => ({
  browserKeyActor: vi.fn(() => Promise.resolve({ set_webpush_subscription })),
}));

import {
  ensureRegisteredDevice,
  registerForAnyAnchor,
} from "./subscribeDevice";
import {
  loadVapidKey,
  storeVapidKey,
  type StoredVapidKey,
} from "./vapidKeyStore";
import { currentDeviceSubscription, subscribeToPush } from "./pushSubscription";
import type { ActorSubclass } from "@icp-sdk/core/agent";
import type { _SERVICE } from "$lib/generated/internet_identity_types";

const HELD = "https://relay.example/held";
const FRESH = "https://relay.example/fresh";
const IDENTITY = BigInt(10_000);

/** The registration goes out under the browser key, not the identity's session. */
const set_webpush_subscription = vi.hoisted(() =>
  vi.fn((_args: { endpoint: string }) => Promise.resolve({ Ok: null })),
);

const stored = vi.mocked(loadVapidKey);
const live = vi.mocked(currentDeviceSubscription);
const subscribe = vi.mocked(subscribeToPush);

const heldKey = (endpoint: string) =>
  ({
    endpoint,
    privateKey: {},
    publicKeyRaw: new Uint8Array([9]),
  }) as unknown as StoredVapidKey;

describe("ensureRegisteredDevice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscribe.mockResolvedValue(FRESH);
  });

  // Subscribing drops the endpoint every other identity on this browser is
  // registered with, so a second identity has to register what is already there.
  it("registers the subscription this browser already holds", async () => {
    stored.mockResolvedValue(heldKey(HELD));
    live.mockResolvedValue({ endpoint: HELD } as PushSubscription);
    await ensureRegisteredDevice(IDENTITY);

    expect(subscribe).not.toHaveBeenCalled();
    expect(set_webpush_subscription.mock.calls[0][0]).toMatchObject({
      endpoint: HELD,
    });
  });

  it("subscribes afresh when the key it holds names a dead endpoint", async () => {
    stored.mockResolvedValue(heldKey(HELD));
    live.mockResolvedValue(undefined);
    await ensureRegisteredDevice(IDENTITY);

    expect(subscribe).toHaveBeenCalledOnce();
    expect(set_webpush_subscription.mock.calls[0][0]).toMatchObject({
      endpoint: FRESH,
    });
  });

  it("subscribes afresh for a browser that holds nothing", async () => {
    stored.mockResolvedValue(undefined);
    live.mockResolvedValue(undefined);
    await ensureRegisteredDevice(IDENTITY);

    expect(subscribe).toHaveBeenCalledOnce();
  });
});

const OTHER = BigInt(20_000);

const appCalls = vi.fn(
  (_args: { anchor_number: bigint; endpoint: string }): Promise<unknown> =>
    Promise.resolve({ Ok: null }),
);

/** The Home Screen app's own actor, which is what it signs these calls as. */
const app = {
  set_webpush_subscription: appCalls,
} as unknown as ActorSubclass<_SERVICE>;

/** The anchors the canister refuses: ones whose reference is switched off, or whose
 *  browser holds no session. Both come back as a key that reaches no browser. */
const refusing = (...anchors: bigint[]) =>
  appCalls.mockImplementation(({ anchor_number }) =>
    anchors.includes(anchor_number)
      ? Promise.resolve({ Err: { InvalidBrowserKey: null } })
      : Promise.resolve({ Ok: null }),
  );

const kept = vi.mocked(storeVapidKey);

describe("registerForAnyAnchor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscribe.mockResolvedValue(FRESH);
    stored.mockResolvedValue(heldKey(HELD));
    live.mockResolvedValue({ endpoint: HELD } as PushSubscription);
    appCalls.mockResolvedValue({ Ok: null });
  });

  it("registers under the first identity the canister accepts", async () => {
    await expect(registerForAnyAnchor([IDENTITY, OTHER], app)).resolves.toBe(
      true,
    );

    expect(appCalls).toHaveBeenCalledOnce();
    expect(appCalls.mock.calls[0][0]).toMatchObject({
      anchor_number: IDENTITY,
    });
  });

  /// One identity that switched this app off, or whose browser is signed out, would
  /// otherwise end every launch of an app that is delivering for the others.
  it("carries on past an identity the canister refuses", async () => {
    refusing(IDENTITY);

    await expect(registerForAnyAnchor([IDENTITY, OTHER], app)).resolves.toBe(
      true,
    );

    expect(appCalls.mock.calls[1][0]).toMatchObject({ anchor_number: OTHER });
  });

  /**
   * Each mint drops the endpoint the one before it handed out. Subscribing per anchor
   * would leave the app registered at an address the push service has already replaced,
   * which is nothing arriving at a screen that says it is all set.
   */
  it("mints one subscription for the whole walk", async () => {
    stored.mockResolvedValue(undefined);
    live.mockResolvedValue(undefined);
    refusing(IDENTITY);

    await registerForAnyAnchor([IDENTITY, OTHER], app);

    expect(subscribe).toHaveBeenCalledOnce();
    expect(appCalls.mock.calls[0][0]).toMatchObject({ endpoint: FRESH });
    expect(appCalls.mock.calls[1][0]).toMatchObject({ endpoint: FRESH });
  });

  /// Nothing reaches this app, and the caller has to be able to say so rather than show
  /// a screen promising delivery.
  it("answers no where every identity refuses", async () => {
    refusing(IDENTITY, OTHER);

    await expect(registerForAnyAnchor([IDENTITY, OTHER], app)).resolves.toBe(
      false,
    );
  });

  /// A key kept over a registration that never landed is one no row names, and the
  /// browser would sign its next pool with it.
  it("keeps a minted key only once the canister has taken it", async () => {
    stored.mockResolvedValue(undefined);
    live.mockResolvedValue(undefined);
    refusing(IDENTITY, OTHER);

    await registerForAnyAnchor([IDENTITY, OTHER], app);

    expect(kept).not.toHaveBeenCalled();
  });

  /**
   * The endpoint is the app's and every anchor it serves shares it, so a pool that is
   * not newer than the one that endpoint holds is not newer for the anchor after this
   * one either, and the canister names nobody at all for its own failures. Walking on
   * buys a call per anchor and the same refusal each time.
   */
  it.each([{ StaleJwtPool: null }, { InternalCanisterError: "no room" }])(
    "stops where no other identity can answer the refusal %s",
    async (refusal) => {
      appCalls.mockResolvedValue({ Err: refusal });

      await expect(
        registerForAnyAnchor([IDENTITY, OTHER], app),
      ).rejects.toThrow();
      expect(appCalls).toHaveBeenCalledOnce();
    },
  );

  /// Only an anchor the canister will not accept is another anchor's to answer. A
  /// failure to reach it at all says nothing about the next one.
  it("stops at a failure another identity cannot answer", async () => {
    appCalls.mockRejectedValue(new Error("offline"));

    await expect(registerForAnyAnchor([IDENTITY, OTHER], app)).rejects.toThrow(
      "offline",
    );
    expect(appCalls).toHaveBeenCalledOnce();
  });
});
