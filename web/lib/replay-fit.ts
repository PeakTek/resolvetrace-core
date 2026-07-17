/**
 * Fit a recorded rrweb replay into the portal's player box.
 *
 * The SDK records the full viewport (e.g. 1440×900); the raw `@rrweb/replay`
 * `Replayer` renders that at native size, so a large recording overflows the
 * player and scrolls. `rrweb-player` solves this by scaling its
 * `.replayer-wrapper` (`transform: scale(min(...)) translate(-50%,-50%)`); the
 * portal drives the raw `Replayer`, so it replicates the scale math here.
 *
 * This is a pure function (no DOM) so it is unit-testable; `rrweb-mount.tsx`
 * measures the container + recorded dimensions and applies the result.
 */

/** Panel-mode player height is capped at this fraction of the viewport height. */
const MAX_PANEL_VH = 0.8;

export interface ReplayFitInput {
  /** Recorded viewport width (from the rrweb Meta event, type 4). */
  readonly recW: number;
  /** Recorded viewport height. */
  readonly recH: number;
  /** Current player-frame client width (px). */
  readonly frameW: number;
  /** Current player-frame client height (px) — only used in fullscreen. */
  readonly frameH: number;
  /** True when the player surface is in browser fullscreen. */
  readonly fullscreen: boolean;
  /** Window inner height (px), for the panel-mode height cap. */
  readonly viewportH: number;
}

export interface ReplayFit {
  /** Scale for the `.replayer-wrapper` transform. Never greater than 1 (no upscale). */
  readonly scale: number;
  /**
   * Explicit player-frame height in px for panel mode, or `null` to let CSS
   * size the frame (fullscreen — the frame fills the screen).
   */
  readonly panelHeight: number | null;
}

function isPos(n: number): boolean {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Clamp a scale to (0, 1] — never upscale past native, never 0/NaN. */
function clampScale(s: number): number {
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.min(s, 1);
}

/**
 * Compute the scale + panel height so the whole recording fits without
 * scrolling. Panel mode fits the frame WIDTH (height follows the recording's
 * aspect ratio, capped at {@link MAX_PANEL_VH} of the viewport so a very tall
 * recording can't dominate the page — letterboxed if the cap bites). Fullscreen
 * fits BOTH axes (fit-to-contain, centered). Unusable dimensions fall back to
 * `{ scale: 1, panelHeight: null }` so the caller can keep `overflow: auto`.
 */
export function computeReplayFit(input: ReplayFitInput): ReplayFit {
  const { recW, recH, frameW, frameH, fullscreen, viewportH } = input;

  if (!isPos(recW) || !isPos(recH) || !isPos(frameW)) {
    return { scale: 1, panelHeight: null };
  }

  if (fullscreen) {
    if (!isPos(frameH)) {
      // Fullscreen without a measured height → fit width only.
      return { scale: clampScale(frameW / recW), panelHeight: null };
    }
    return {
      scale: clampScale(Math.min(frameW / recW, frameH / recH)),
      panelHeight: null,
    };
  }

  const vh = isPos(viewportH) ? viewportH : 800;
  const naturalH = Math.round(recH * (frameW / recW));
  const maxH = Math.round(vh * MAX_PANEL_VH);
  const panelHeight = Math.max(1, Math.min(naturalH, maxH));
  const scale = clampScale(Math.min(frameW / recW, panelHeight / recH));
  return { scale, panelHeight };
}
