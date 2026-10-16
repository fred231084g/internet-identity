import { afterEach, describe, expect, it } from "vitest";
import { isStandalone } from "./standalone";

/**
 * The display modes a browser reports, with only `matching` taken to be this one.
 *
 * Defined rather than spied on: jsdom serves no `matchMedia`, which is the API this reads
 * the answer off everywhere but an older iOS.
 */
const displayMode = (matching?: string): void => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query === `(display-mode: ${matching})`,
    }),
  });
};

/** What iOS answered with before it supported `display-mode`, which it still answers. */
const legacyStandalone = (value: boolean | undefined): void => {
  Object.defineProperty(navigator, "standalone", {
    configurable: true,
    value,
  });
};

afterEach(() => {
  legacyStandalone(undefined);
});

describe("isStandalone", () => {
  /**
   * The same URL shows the install steps in a tab and runs the app on the Home Screen, so
   * a tab read as the installed app would offer the user an app they are already in.
   */
  it("says a browser tab is not the installed app", () => {
    displayMode();

    expect(isStandalone()).toBe(false);
  });

  it.each(["standalone", "fullscreen"])(
    "reads the installed app off display-mode %s",
    (mode) => {
      displayMode(mode);

      expect(isStandalone()).toBe(true);
    },
  );

  /** iOS is the only platform this matters on, and the one that answered this way before
   *  it supported `display-mode`. */
  it("reads the installed app off navigator.standalone", () => {
    displayMode();
    legacyStandalone(true);

    expect(isStandalone()).toBe(true);
  });

  it("does not read a browser tab off navigator.standalone", () => {
    displayMode();
    legacyStandalone(false);

    expect(isStandalone()).toBe(false);
  });
});
