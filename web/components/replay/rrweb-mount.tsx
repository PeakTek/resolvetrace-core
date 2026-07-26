"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Replayer } from "@rrweb/replay";
import "@rrweb/replay/dist/style.css";
import { computeReplayFit } from "@/lib/replay-fit";

/**
 * Client-only rrweb playback surface (Wave-24).
 *
 * Embeds the rrweb `Replayer` (from `@rrweb/replay`, the playback engine the
 * `rrweb-player` package is built on) and a compact controller (play/pause,
 * scrubber, speed, fullscreen). We drive the Replayer directly rather than
 * mounting rrweb-player's Svelte component: under Next 16 + React 19 + Turbopack
 * the Svelte wrapper's onMount completes but never attaches its iframe (blank
 * frame), whereas the underlying Replayer renders correctly.
 *
 * The raw Replayer renders the recording at its native viewport size, so a
 * full-screen recording would overflow and scroll. We replicate rrweb-player's
 * fit: scale `.replayer-wrapper` so the whole recorded screen fits the frame
 * (see `computeReplayFit`), and offer a Fullscreen button. The visible content
 * is exclusively the SDK's already-masked DOM — scaling is purely visual.
 *
 * Loaded via `next/dynamic({ ssr: false })` from ReplayPlayer, so the rrweb
 * import never runs during SSR.
 */

export interface RrwebInstance {
  /** Seek to a player-relative offset in ms (matches rrweb-player's goto). */
  goto(timeOffsetMs: number, play?: boolean): void;
  getMetaData(): { startTime: number; endTime: number; totalTime: number };
}

const SPEEDS = [1, 2, 4, 8];

function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Recorded viewport dims from the first rrweb Meta event (type 4). */
function recordedDimensions(events: unknown[]): { w: number; h: number } | null {
  for (const ev of events) {
    const e = ev as { type?: number; data?: { width?: number; height?: number } };
    if (e?.type === 4 && e.data) {
      const w = e.data.width;
      const h = e.data.height;
      if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) {
        return { w, h };
      }
    }
  }
  return null;
}

export default function RrwebMount({
  events,
  onReady,
}: {
  events: unknown[];
  onReady?: (inst: RrwebInstance) => void;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLElement | null>(null);
  const replayerRef = useRef<Replayer | null>(null);
  const rafRef = useRef<number | null>(null);

  const [totalTime, setTotalTime] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [isFs, setIsFs] = useState(false);

  // Recorded dimensions (from the Meta event) — computed at render so the frame
  // can pick its layout immediately (scaled vs. the overflow-auto fallback).
  const dims = useMemo(() => recordedDimensions(events), [events]);
  const dimsRef = useRef(dims);
  dimsRef.current = dims;
  const hasDims = dims !== null;

  /** Scale `.replayer-wrapper` so the whole recording fits the frame. */
  const fit = useCallback(() => {
    const frame = frameRef.current;
    const wrapper = wrapperRef.current;
    const d = dimsRef.current;
    if (!frame || !wrapper || !d) return;
    const fullscreen =
      typeof document !== "undefined" &&
      document.fullscreenElement === surfaceRef.current;
    const { scale, panelHeight } = computeReplayFit({
      recW: d.w,
      recH: d.h,
      frameW: frame.clientWidth,
      frameH: frame.clientHeight,
      fullscreen,
      viewportH: typeof window !== "undefined" ? window.innerHeight : 800,
    });
    // Fullscreen: let CSS (flex-1) size the frame; panel: fit the height to it.
    frame.style.height = panelHeight !== null ? `${panelHeight}px` : "";
    wrapper.style.transform = `scale(${scale}) translate(-50%, -50%)`;
  }, []);

  // Build the Replayer once per mount. ReplayPlayer remounts this component
  // (via `key`) on reload / segment switch, so a fresh instance is created.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    frame.innerHTML = "";

    let replayer: Replayer;
    try {
      replayer = new Replayer(events as never, {
        root: frame,
        liveMode: false,
        // We trust the SDK's masking; the player only renders what it received.
        mouseTail: false,
      });
    } catch {
      return;
    }
    replayerRef.current = replayer;

    // Prepare the wrapper for absolute-centered scaling (as rrweb-player does).
    const wrapper = frame.querySelector(".replayer-wrapper") as HTMLElement | null;
    wrapperRef.current = wrapper;
    if (wrapper && dimsRef.current) {
      // Mirror rrweb-player's fit exactly: wrapper top-left anchored at the
      // frame centre, `transform-origin: top left`, and the scale is applied as
      // `scale(s) translate(-50%,-50%)` (see fit()) so the recording ends up
      // centred and scaled. transform-origin MUST be top-left for that formula.
      wrapper.style.position = "absolute";
      wrapper.style.left = "50%";
      wrapper.style.top = "50%";
      wrapper.style.width = `${dimsRef.current.w}px`;
      wrapper.style.height = `${dimsRef.current.h}px`;
      wrapper.style.transformOrigin = "top left";
    }

    const meta = replayer.getMetaData();
    setTotalTime(meta.totalTime);

    const inst: RrwebInstance = {
      goto: (offsetMs, play) => {
        replayer.pause();
        replayer.play(offsetMs);
        if (!play) {
          // Land paused on the target frame.
          replayer.pause(offsetMs);
        }
        setCurrentTime(offsetMs);
        setPlaying(Boolean(play));
      },
      getMetaData: () => replayer.getMetaData(),
    };
    onReady?.(inst);

    // Render the first frame so the surface isn't blank before play, then fit.
    replayer.pause(0);
    fit();

    // Re-fit on container resize (panel width / fullscreen toggles) and on
    // fullscreen enter/exit.
    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver(() => fit());
      ro.observe(frame);
    } catch {
      ro = null;
    }
    const onFsChange = () => {
      setIsFs(document.fullscreenElement === surfaceRef.current);
    };
    document.addEventListener("fullscreenchange", onFsChange);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      try {
        replayer.pause();
      } catch {
        /* ignore */
      }
      if (ro) {
        try {
          ro.disconnect();
        } catch {
          /* ignore */
        }
      }
      document.removeEventListener("fullscreenchange", onFsChange);
      frame.innerHTML = "";
      wrapperRef.current = null;
      replayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fit after the fullscreen layout has committed (frame size changed).
  useEffect(() => {
    fit();
  }, [isFs, fit]);

  // Poll the replayer's current time while playing to advance the scrubber.
  useEffect(() => {
    if (!playing) return;
    function tick() {
      const r = replayerRef.current;
      if (r) {
        const t = r.getCurrentTime();
        setCurrentTime(t);
        if (t >= totalTime && totalTime > 0) {
          setPlaying(false);
          return;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, totalTime]);

  function togglePlay() {
    const r = replayerRef.current;
    if (!r) return;
    if (playing) {
      r.pause();
      setPlaying(false);
    } else {
      const from = currentTime >= totalTime ? 0 : currentTime;
      r.play(from);
      setPlaying(true);
    }
  }

  function onScrub(e: React.ChangeEvent<HTMLInputElement>) {
    const r = replayerRef.current;
    if (!r) return;
    const t = Number(e.target.value);
    setCurrentTime(t);
    if (playing) {
      r.play(t);
    } else {
      r.pause(t);
    }
  }

  function changeSpeed(next: number) {
    const r = replayerRef.current;
    if (!r) return;
    r.setConfig({ speed: next });
    setSpeed(next);
  }

  const toggleFullscreen = useCallback(() => {
    const el = surfaceRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        void el.requestFullscreen();
      }
    } catch {
      /* fullscreen can reject; ignore */
    }
  }, []);

  return (
    <div
      ref={surfaceRef}
      className={
        isFs
          ? "rt-replay-surface fixed inset-0 z-50 flex flex-col gap-2 bg-neutral-900 p-2"
          : "rt-replay-surface space-y-3"
      }
    >
      <div
        ref={frameRef}
        className={
          "rt-replay-frame rounded-md border border-neutral-200 " +
          (isFs
            ? "min-h-0 flex-1 bg-neutral-900"
            : hasDims
              ? "overflow-hidden bg-neutral-50"
              : "overflow-auto bg-neutral-50")
        }
        style={
          hasDims && !isFs
            ? { position: "relative", minHeight: 120 }
            : hasDims
              ? { position: "relative" }
              : { minHeight: 280, maxHeight: 560 }
        }
      />
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-neutral-200 bg-white px-3 py-2">
        <button
          type="button"
          onClick={togglePlay}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <span className="font-mono text-xs tabular-nums text-neutral-500">
          {formatClock(currentTime)} / {formatClock(totalTime)}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(totalTime, 1)}
          step={50}
          value={Math.min(currentTime, totalTime)}
          onChange={onScrub}
          className="h-1 flex-1 cursor-pointer accent-neutral-800"
          aria-label="Seek replay"
        />
        <div className="flex items-center gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => changeSpeed(s)}
              className={
                "rounded px-1.5 py-0.5 text-xs font-medium " +
                (speed === s
                  ? "bg-neutral-900 text-white"
                  : "text-neutral-500 hover:bg-neutral-100")
              }
            >
              {s}x
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={toggleFullscreen}
          className="rounded border border-neutral-300 px-2 py-0.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100"
          aria-pressed={isFs}
        >
          {isFs ? "Exit fullscreen" : "Fullscreen"}
        </button>
      </div>
    </div>
  );
}
