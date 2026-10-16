/**
 * Watches for the Home Screen app registering, so the tab that showed the install steps
 * can say the thing is done.
 *
 * The app runs in its own storage partition and nothing in this tab can see it, so the
 * canister is the only party that knows. It is asked rather than told: there is no
 * channel between the two documents.
 */
import { POLL_INTERVAL_MS } from "$lib/constants/polling.constants";
import { browserAppStatus } from "$lib/utils/notifications/appStatus";

/**
 * Returns the function that stops watching, which also runs before the callback.
 *
 * `replacingApp` where this browser still points at an app the user has just said is
 * gone. That record outlives the app, subscribed and enabled the whole time, so a
 * watcher that trusted it would call the install done while the user is still on the
 * first step. What it waits for instead is the record being heard from again: an app the
 * user deleted never calls, so `last_seen_ns` moving past where it stood is the app they
 * have just added and can be nothing else. Waiting for the old record to disappear would
 * not do, because a record with no endpoint registered has nothing to push to and so
 * nothing that can ever bounce it away.
 */
export const watchForInstall = (
  identityNumber: bigint,
  onDelivering: () => void,
  { replacingApp = false }: { replacingApp?: boolean } = {},
): (() => void) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  /** How far the record had got when this started watching, which delivering has to beat
   *  to be the new app. `undefined` once there is no old record to outlive. */
  let replacedLastSeen: bigint | undefined;
  let baselineTaken = !replacingApp;

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
  };

  const poll = async () => {
    if (stopped) {
      return;
    }
    const status = await browserAppStatus(identityNumber);
    // Asked again on the way out: the caller may have stopped watching while the query
    // was in flight, and what the callback does cannot be undone.
    if (stopped) {
      return;
    }
    switch (status.kind) {
      case "no-app":
        // Nothing of the old app left to be mistaken for the new one.
        baselineTaken = true;
        replacedLastSeen = undefined;
        break;
      case "app":
        if (!baselineTaken) {
          baselineTaken = true;
          replacedLastSeen = status.app.last_seen_ns;
          break;
        }
        // Subscribed is not delivering: a reference the identity turned off is skipped
        // when the canister picks who to send to, so the app would never be heard from.
        if (
          (replacedLastSeen === undefined ||
            status.app.last_seen_ns > replacedLastSeen) &&
          status.app.subscribed &&
          status.app.enabled
        ) {
          stop();
          onDelivering();
          return;
        }
        break;
      case "unanswered":
        // A query that could not be made is not an answer, and taking a baseline from
        // one would let a flaky network stand in for the app the user deleted.
        break;
    }
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
  };

  timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
  return stop;
};

/**
 * Watches what a probe does, which is the only way a browser can tell a live app from
 * one the user deleted.
 *
 * `onAnswered` where the probe has left this browser's queue, which is what says the app
 * is still there to take it. `onGone` where the record itself is gone, which is what
 * the push service reporting the endpoint dead leaves behind.
 *
 * Both are read from this browser's own entry, so an app on another device answering its
 * own probe can never stand in for this one.
 */
export const watchProbe = (
  identityNumber: bigint,
  { onAnswered, onGone }: { onAnswered: () => void; onGone: () => void },
): (() => void) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
  };

  const poll = async () => {
    if (stopped) {
      return;
    }
    const status = await browserAppStatus(identityNumber);
    if (stopped) {
      return;
    }
    switch (status.kind) {
      case "no-app":
        stop();
        onGone();
        return;
      case "app":
        // `pending_probe` carries the probe this browser last sent for as long as it is
        // still queued, so it emptying is the app taking it.
        if (status.app.pending_probe.length === 0) {
          stop();
          onAnswered();
          return;
        }
        break;
      case "unanswered":
        // Neither answer, and the wrong one either way: a user whose app is working
        // would be told to install it again.
        break;
    }
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
  };

  timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
  return stop;
};
