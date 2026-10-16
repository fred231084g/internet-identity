import { describe, expect, it } from "vitest";
import { decodeLinkToken, encodeLinkToken } from "./linkToken";

/** 64 bytes, which is the only length the canister accepts, over the whole byte range,
 *  so an encoding that mangles a value fails here rather than at the canister. */
const signature = Uint8Array.from({ length: 64 }, (_, index) => index * 4);

const token = {
  identityNumber: BigInt(10_772),
  expiresAtNs: BigInt("1790000000000000000"),
  signature,
};

describe("link token", () => {
  it("survives the trip through the URL", () => {
    expect(decodeLinkToken(`#${encodeLinkToken(token)}`)).toEqual({
      kind: "token",
      token,
    });
  });

  it("reads a fragment written without its hash", () => {
    expect(decodeLinkToken(encodeLinkToken(token))).toEqual({
      kind: "token",
      token,
    });
  });

  /** The ordinary launch, every time the user opens the installed app after the first:
   *  nothing to claim with, and nothing broken either. */
  it.each([["#"], [""], ["#not-a-token"]])(
    "reads no token from %o",
    (fragment) => {
      expect(decodeLinkToken(fragment)).toEqual({ kind: "no-token" });
    },
  );

  /**
   * A fragment that names part of a token and not the rest is an install link that
   * arrived damaged. A browser signed it and is waiting on the other end, so this is not
   * the launch of someone who has not started: reading the two as the same value shows
   * the install steps to a user who has already walked them.
   */
  it.each([["#anchor=1"], ["#anchor=1&exp=2"], ["#sig=AAE"]])(
    "reads a damaged token from %o",
    (fragment) => {
      expect(decodeLinkToken(fragment)).toEqual({
        kind: "unreadable",
        reason: "the token is missing a field",
      });
    },
  );

  it("reports a signature that is not base64url", () => {
    expect(decodeLinkToken("#anchor=1&exp=2&sig=!!!!")).toMatchObject({
      kind: "unreadable",
    });
  });

  it("reports an anchor that is not a number", () => {
    const base64 = encodeLinkToken({ ...token, identityNumber: BigInt(1) });

    expect(
      decodeLinkToken(base64.replace("anchor=1", "anchor=x")),
    ).toMatchObject({ kind: "unreadable" });
  });

  /** The canister refuses any other length, so the token is spent for nothing. The length
   *  is knowable here instead of after a round trip. */
  it("reports a signature that is not 64 bytes", () => {
    const short = encodeLinkToken({
      ...token,
      signature: new Uint8Array([0, 1, 250]),
    });

    expect(decodeLinkToken(short)).toEqual({
      kind: "unreadable",
      reason: "the signature is 3 bytes, not 64",
    });
  });

  /** The signature is bytes, and a URL carries text: `+` and `/` from plain base64 would
   *  not survive a fragment, so the encoding has to be the URL-safe alphabet. */
  it("encodes the signature without characters a URL would change", () => {
    const encoded = encodeLinkToken({
      ...token,
      signature: new Uint8Array(64).fill(251),
    });

    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("%2F");
  });
});
