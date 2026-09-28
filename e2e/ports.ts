/* Per-worker ports for e2e stacks (#164).

   Specs give each Playwright worker its own block of ports
   (`base + TEST_WORKER_INDEX * step`). The worker index keeps growing after a
   failure (a failed test gets a new worker), so after enough retries a block
   can land on a port that browsers and `fetch` refuse to connect to, and the
   stack looks dead although it's healthy. For example, worker 20 → 6668
   (IRC), worker 3 → 5060 (SIP), worker 7 → 6000 (X11).

   `safePort` moves such a port out of the refused range; every spec computes
   its ports through `wport`. `ports.spec.ts` checks that no port these
   helpers return is refused by `fetch`. */

/** Ports on the Fetch standard's "bad ports" list (https://fetch.spec.whatwg.org/#port-blocking),
    which Chromium and undici `fetch` refuse without opening a socket. */
export const BAD_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

/* Spec ports live below ~12000, so a refused port moves up by a fixed amount
   into a range no spec uses. Different inputs keep different outputs. */
const SHIFT = 20_000;

/** `p`, or `p + 20000` when `p` is refused by browsers/fetch. */
export const safePort = (p: number): number =>
  BAD_PORTS.has(p) ? p + SHIFT : p;

/** This worker's index (stable per process; see the note above on growth). */
export const WORKER = Number(process.env.TEST_WORKER_INDEX ?? "0");

/** `base` shifted into this worker's block, never on a refused port. */
export const wport = (base: number, step = 100): number =>
  safePort(base + WORKER * step);
