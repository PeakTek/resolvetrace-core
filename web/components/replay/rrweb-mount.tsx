"use client";

import { useEffect, useRef, useState } from "react";
import { Replayer } from "@rrweb/replay";
import "@rrweb/replay/dist/style.css";

/**
 * Client-only rrweb playback surface (Wave-24).
 *
 * Embeds the rrweb `Replayer` (from `@rrweb/replay`, the playback engine the
 * `rrweb-player` package is built on) and a compact controller (play/pause,
 * scrubber, speed). We drive the Replayer directly rather than mounting
 * rrweb-player's Svelte component: under Next 16 + React 19 + Turbopack the
 * Svelte wrapper's onMount completes but never attaches its iframe (blank
 * frame), whereas the underlying Replayer renders correctly — see the Wave-24
 * follow-up. The visible content is exclusively the SDK's already-masked DOM.
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

export default function RrwebMount({
  events,
  onReady,
}: {
  events: unknown[];
  onReady?: (inst: RrwebInstance) => void;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const replayerRef = useRef<Replayer | null>(null);
  const rafRef = useRef<number | null>(null);

  const [totalTime, setTotalTime] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  // Build the Replayer once per mount. ReplayPlayer remounts this component
  // (via `key`) on reload, so a fresh instance is created each time.
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

    // Render the first frame so the surface isn't blank before play.
    replayer.pause(0);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      try {
        replayer.pause();
      } catch {
        /* ignore */
      }
      frame.innerHTML = "";
      replayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  return (
    <div className="rt-replay-surface space-y-3">
      <div
        ref={frameRef}
        className="rt-replay-frame overflow-auto rounded-md border border-neutral-200 bg-neutral-50"
        style={{ minHeight: 280, maxHeight: 560 }}
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
      </div>
    </div>
  );
}
