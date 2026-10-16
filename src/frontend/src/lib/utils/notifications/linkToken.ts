/**
 * The token that travels from the browser that installed this app to the app itself.
 *
 * It rides the URL fragment, because iOS bookmarks the whole URL when the user adds the
 * page to the Home Screen: the installed app launches holding a secret only whoever
 * performed the install ever saw. A fragment rather than a query so it is never sent to
 * the gateway and never reaches a server log.
 */

export interface LinkToken {
  identityNumber: bigint;
  expiresAtNs: bigint;
  signature: Uint8Array;
}

const base64UrlEncode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const base64UrlDecode = (value: string): Uint8Array =>
  Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (character) => character.charCodeAt(0),
  );

/** What the browser puts in the URL it tells the user to install from. */
export const encodeLinkToken = (token: LinkToken): string =>
  new URLSearchParams({
    anchor: token.identityNumber.toString(),
    exp: token.expiresAtNs.toString(),
    sig: base64UrlEncode(token.signature),
  }).toString();

/** A browser key is P-256 and the signature the raw `r || s` pair WebCrypto produces.
 *  Must match `BROWSER_KEY_SIGNATURE_BYTES` in `browser_key.rs`, which refuses any other
 *  length outright: a token of the wrong length is known to be spent for nothing here,
 *  rather than after a round trip. */
const LINK_TOKEN_SIGNATURE_BYTES = 64;

/**
 * What a launch's fragment says about the token it carries.
 *
 * `unreadable` is not `no-token`. A launch with no token is the ordinary one, every time
 * the user opens the app after the install, and the app goes on to ask the canister what
 * it is linked to. A fragment that cannot be read is an install link that arrived damaged:
 * there is a browser waiting on the other end of it, and what this app needs is a fresh
 * link rather than the steps it shows someone who has not started.
 */
export type FragmentLinkToken =
  | { kind: "token"; token: LinkToken }
  | { kind: "no-token" }
  | { kind: "unreadable"; reason: string };

/** What the browser puts in the URL, read back. */
export const decodeLinkToken = (fragment: string): FragmentLinkToken => {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const anchor = params.get("anchor");
  const expiry = params.get("exp");
  const signature = params.get("sig");
  if (anchor === null && expiry === null && signature === null) {
    return { kind: "no-token" };
  }
  if (anchor === null || expiry === null || signature === null) {
    return { kind: "unreadable", reason: "the token is missing a field" };
  }
  try {
    const bytes = base64UrlDecode(signature);
    if (bytes.length !== LINK_TOKEN_SIGNATURE_BYTES) {
      return {
        kind: "unreadable",
        reason: `the signature is ${bytes.length} bytes, not ${LINK_TOKEN_SIGNATURE_BYTES}`,
      };
    }
    return {
      kind: "token",
      token: {
        identityNumber: BigInt(anchor),
        expiresAtNs: BigInt(expiry),
        signature: bytes,
      },
    };
  } catch (error) {
    return {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

/** How long a token is good for. Long enough to walk the install steps at a reading
 *  pace and open the app, short enough that one left in a browser history is of little
 *  use. A token refused for age is replaced by starting the steps again. */
export const LINK_TOKEN_LIFETIME_MS = 30 * 60 * 1000;
