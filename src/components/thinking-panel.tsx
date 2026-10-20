"use client";

import { ACT_CLOCK_MS } from "@/lib/pacing";
import { ChipDot } from "./table-art";
import { useRemaining } from "./use-remaining";
import { Badge } from "./ui";

export interface BrainState {
  seatName: string | null;
  color: string | null;
  street: string;
  reasoning: string;
  streaming: boolean;
  equity: number | null;
  potOdds: number | null;
  made: string | null;
  draws: string[];
  action: string | null;
  amount: number;
  failure: string | null;
  elapsedMs: number | null;
  /** What the agent said out loud, if it said anything. */
  say?: string | null;
  /** Reasoning sealed until the hand is over, and shown when the cards are. */
  sealed?: boolean;
}

/** The draws a hand read is carrying, in the words the panel prints them in. */
export function drawsOf(
  read: { flushDraw: boolean; openEnded: boolean; gutshot: boolean; overcards: boolean } | null,
): string[] {
  if (!read) return [];
  return [
    read.flushDraw && "flush draw",
    read.openEnded && "open-ended",
    read.gutshot && "gutshot",
    read.overcards && "two overcards",
  ].filter((value): value is string => typeof value === "string");
}

/**
 * What the agent is thinking, and why it is trustworthy. The panel is the
 * reasoning and the decision it produced, in words a first-time reader knows.
 *
 * It also tells the truth about itself. A decision the model missed is
 * reported as a timeout, because the whole point of the panel is that it is
 * the instrument.
 */
export function ThinkingPanel({
  brain,
  deadline,
  footnote,
  live = true,
}: {
  brain: BrainState | null;
  /** Epoch milliseconds the act clock expires, if a seat is thinking. */
  deadline?: number | null;
  /** Context for a panel that is replaying a past hand. */
  footnote?: string | null;
  /**
   * Whether a clock can run here. A replay is clockless, so it gives the room
   * back to the name.
   */
  live?: boolean;
}) {
  // The agent's own chip marks whose panel this is. The meters and the caret
  // are the instrument, and an instrument that keeps one colour for everyone
  // is easy to read.
  const reasoning = prose(brain?.reasoning ?? "");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex min-h-6 items-center gap-2">
          {brain?.seatName ? (
            <>
              {brain.color ? (
                <ChipDot color={brain.color} size={14} />
              ) : (
                <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted" aria-hidden />
              )}
              <span className="truncate text-sm font-semibold text-ink">
                {brain.seatName}
              </span>
              {/* "is deciding" while the action is pending; once it lands the line says
              "decided", so the header and the decision always agree, replays
              included. */}
              <span className="shrink-0 text-sm text-muted">
                {brain.action ? "decided" : "is deciding"}
              </span>
              <Badge className="ml-auto capitalize">{brain.street}</Badge>
            </>
          ) : (
            <span className="text-sm text-muted">
              Waiting for the next decision
            </span>
          )}
        </div>
        {live ? <ActClock deadline={deadline ?? null} /> : null}
      </div>

      <div
        className="scroll-y min-h-0 flex-1 px-4 py-4"
        data-panel-scroll
        tabIndex={0}
      >
        <p className="label mb-2 text-faint">Its reasoning</p>
        {brain?.sealed ? (
          <p
            className={`text-sm leading-relaxed text-muted ${brain.streaming ? "caret" : ""}`}
          >
            Sealed until showdown.
          </p>
        ) : reasoning || brain?.streaming ? (
          // A plain region. Reasoning arrives a token at a time, so the decision
          // below is the part announced to a screen reader, once, when it settles.
          <p
            className={`text-sm leading-relaxed text-ink ${brain?.streaming ? "caret" : ""}`}
          >
            {reasoning || (
              <span className="text-faint">Reading the board…</span>
            )}
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-muted">
            Reasoning opens here at showdown.
          </p>
        )}

        {brain?.failure ? (
          <p className="mt-4 rounded-control border border-warning/35 bg-warning/10 px-3 py-2 text-sm text-ink">
            {brain.seatName ?? "This agent"} {brain.failure}. The seat{" "}
            {brain.action === "check" ? "checked" : "folded"} automatically.
          </p>
        ) : null}
      </div>

      {brain ? (
        <div className="shrink-0 border-t border-line px-4 py-3">
          <PriceLine
            equity={brain.sealed ? null : brain.equity}
            price={brain.potOdds}
            sealed={Boolean(brain.sealed)}
            read={
              brain.sealed
                ? null
                : [brain.made, ...brain.draws].filter(Boolean).join(", ") || null
            }
          />
        </div>
      ) : null}

      <div
        className="shrink-0 border-t border-line px-4 py-3"
        aria-live="polite"
        aria-atomic="true"
      >
        <p className="label mb-1.5 text-faint">It decided</p>
        <div className="min-h-11">
          {brain?.action ? (
            <>
              <div className="flex items-baseline gap-3">
                <span className="display text-[1.625rem] text-ink capitalize">
                  {brain.action}
                  {brain.amount > 0
                    ? ` ${brain.amount.toLocaleString("en-US")}`
                    : ""}
                </span>
                {brain.elapsedMs != null ? (
                  <span className="mono ml-auto text-xs text-faint tabular-nums">
                    took {(brain.elapsedMs / 1000).toFixed(1)}s
                  </span>
                ) : null}
              </div>
              {/*
              Table talk lives here, in the panel. The strip of cloth between a seat and
              the board belongs to its bet and its action, the two things a spectator
              needs to see at all times.
            */}
              {brain.say ? (
                <p className="mt-1.5 text-sm text-muted italic">
                  “{brain.say}”
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-faint">Waiting on this decision.</p>
          )}
        </div>
        {footnote ? (
          <p className="mt-1.5 truncate text-xs text-faint">{footnote}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The arithmetic under every decision at this table, drawn as one line.
 *
 * Break-even is what a call costs as a share of the pot it would win, and it is
 * public: anyone at the rail can work it out from the pot and the bet. Equity is
 * the arena's own count of how often this holding wins, and it names the cards,
 * so it stays sealed exactly as long as the reasoning does and fills the line
 * once the hand is shown. Watching the fill land either side of the tick
 * is watching the decision get made, and a fill that stops just short of it is
 * the reason the seat took so long.
 *
 * One neutral colour. A raise can be right below break-even and a call wrong
 * above it, so the line reports the two numbers and leaves the judgement to
 * whoever is reading the reasoning beside it.
 */
function PriceLine({
  equity,
  price,
  sealed,
  read,
}: {
  equity: number | null;
  price: number | null;
  sealed: boolean;
  /** What the equity was counted for, in the hand-read's own words. */
  read: string | null;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4 text-xs">
        <span
          className="flex min-w-0 items-baseline gap-1.5"
          title="How often this hand wins against random cards, from the arena's own count."
        >
          <span className="shrink-0 text-faint">Equity</span>
          <span className="mono shrink-0 text-ink tabular-nums">
            {equity != null ? percent(equity) : sealed ? "sealed" : "–"}
          </span>
          {read ? <span className="truncate text-faint">{read}</span> : null}
        </span>
        <span
          className="flex shrink-0 items-baseline gap-1.5"
          title="The share of the pot a call has to win to pay for itself."
        >
          <span className="text-faint">Break-even</span>
          <span className="mono text-live tabular-nums">
            {price != null ? percent(price) : "–"}
          </span>
        </span>
      </div>

      {/* The figures above say it in words; the line says it at a glance. */}
      <div className="relative mt-2 h-1.5 rounded-full bg-surface-3" aria-hidden>
        {equity != null ? (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-ink transition-[width] duration-500 ease-out"
            style={{ width: percent(equity) }}
          />
        ) : null}
        {/* Ringed in the card's own fill, so the tick reads the same over
            the white of a filled line as over the empty track. */}
        {price != null ? (
          <span
            className="absolute -top-1 -bottom-1 w-[3px] -translate-x-1/2 rounded-full bg-live shadow-[0_0_0_2px_var(--color-surface)]"
            style={{ left: percent(price) }}
          />
        ) : null}
      </div>
    </div>
  );
}

function percent(share: number): string {
  return `${Math.round(Math.max(0, Math.min(1, share)) * 100)}%`;
}

/**
 * How long is left on the decision. It is a plain progress bar because a
 * countdown is one of the few things every reader already knows how to read.
 *
 * It keeps its space between decisions, so the panel holds still and the
 * reasoning being read stays on its line.
 */
function ActClock({ deadline }: { deadline: number | null }) {
  const remaining = useRemaining(deadline);

  const running = deadline != null;
  const fraction = running
    ? Math.max(0, Math.min(1, remaining / ACT_CLOCK_MS))
    : 0;

  return (
    <div
      className={`mt-2.5 transition-opacity duration-200 ${running ? "" : "opacity-0"}`}
      aria-hidden={!running}
    >
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full rounded-full bg-live transition-[width] duration-100 ease-linear"
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
      <p className="mono mt-1.5 text-xs text-faint tabular-nums">
        {(remaining / 1000).toFixed(1)}s left to act
      </p>
    </div>
  );
}

/**
 * The model writes its reasoning, then a JSON object with the action. The
 * reasoning is what belongs on screen, so the object is cut off mid-stream as
 * well as at the end.
 */
function prose(text: string): string {
  // A brace that starts the decision object ends the prose. A brace inside a
  // sentence is just a brace, and the thought carries on past it.
  const object = text.search(/\{\s*"/);
  return (object >= 0 ? text.slice(0, object) : text)
    .replace(/```(?:json)?/g, "")
    .trim();
}
