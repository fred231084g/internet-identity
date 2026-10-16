import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/utils/notifications/notificationAppKey", () => ({
  appPublicKey: () => Promise.resolve(new Uint8Array([1, 2, 3])),
}));

const { linkWithToken } = await import("./link");

type Actor = Parameters<typeof linkWithToken>[0];
type KeyRecord = Parameters<typeof linkWithToken>[1];

/** The key is read through a mock, so the record the call carries is never looked at. */
const RECORD = {} as unknown as KeyRecord;

const TOKEN = {
  identityNumber: BigInt(10_000),
  expiresAtNs: BigInt(1_700_000_000_000_000_000),
  signature: new Uint8Array([4, 5, 6]),
};

const answering = (response: unknown): Actor =>
  ({
    link_notification_app: () => Promise.resolve(response),
  }) as unknown as Actor;

/**
 * Every variant `link_notification_app` can refuse with, because the outcome decides
 * which screen ends the launch and only one of them is a failure the user can retry.
 */
describe("linkWithToken", () => {
  it("links where the canister took the token", async () => {
    await expect(
      linkWithToken(answering({ Ok: null }), RECORD, TOKEN),
    ).resolves.toEqual({ status: "linked" });
  });

  /// A fresh token is signed by a key the canister accepts, so the install steps are
  /// what these are owed and not a terminal screen.
  it.each(["InvalidLinkToken", "LinkTokenExpired"])(
    "asks for a fresh token on %s",
    async (type) => {
      await expect(
        linkWithToken(answering({ Err: { [type]: null } }), RECORD, TOKEN),
      ).resolves.toEqual({ status: "token-refused", reason: type });
    },
  );

  /// Neither is about the token, and this app has only the one key: offering a fresh
  /// token would send the user round the install for an app that cannot link either way.
  it.each(["KeyAlreadyInUse", "CallerIsNotTheApp"])(
    "ends the launch on the app's own key for %s",
    async (type) => {
      await expect(
        linkWithToken(answering({ Err: { [type]: null } }), RECORD, TOKEN),
      ).resolves.toEqual({ status: "key-refused", reason: type });
    },
  );

  it("reports what the canister could not do as a failure", async () => {
    await expect(
      linkWithToken(
        answering({ Err: { InternalCanisterError: "out of memory" } }),
        RECORD,
        TOKEN,
      ),
    ).resolves.toEqual({
      status: "failed",
      reason: "InternalCanisterError",
    });
  });

  /// Reaching the canister at all is the one failure that is not a variant, and the
  /// message is the whole of what there is to show.
  it("reports a call that never arrived as a failure", async () => {
    const actor = {
      link_notification_app: () => Promise.reject(new Error("no consensus")),
    } as unknown as Actor;

    await expect(linkWithToken(actor, RECORD, TOKEN)).resolves.toEqual({
      status: "failed",
      reason: "no consensus",
    });
  });
});
