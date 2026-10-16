/** How often a screen asks the canister for something it is waiting on. Slow enough to
 *  be nothing on a query, often enough that the answer arrives while the user is still
 *  looking at the screen that is waiting for it. */
export const POLL_INTERVAL_MS = 3000;
