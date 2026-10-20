"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatChips } from "@/lib/economy";
import type { TableView } from "@/server/view";
import { useAccount } from "./account-context";
import { Felt, moveWords } from "./felt";
import { ThinkingPanel, drawsOf, type BrainState } from "./thinking-panel";
import { ChipDot, DealerButton } from "./table-art";
import { seatLabel, useMatchStream } from "./use-match-stream";
import { useLobby } from "./use-lobby";
import { BackLink, Badge, ButtonLink, Card, LiveBadge } from "./ui";

type Tab = "thinking" | "players" | "log";

/**
 * How often, and how many times, a finished match asks for its result page.
 * Settling is one transaction, so it lands well inside the first few; the
 * limit gives a page on an instance that misses it a natural end.
 */
const RESULT_CHECK_MS = 1_500;
const RESULT_CHECKS = 10;

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "thinking", label: "Thinking" },
  { id: "players", label: "Players" },
  { id: "log", label: "Hand log" },
];

/**
 * The watch page, laid out the way any live-video page is: one big stage, and a
 * side panel with named tabs beside it. The panel is the reason to be here, so
 * it says what it is at the top of every tab, so every figure has a label.
 */
export function Arena({ matchId }: { matchId: string }) {
  const {
    table,
    isStreaming,
    idleReason,
    connected,
    gaveUp,
    moved,
    potKey,
    actionKeys,
  } = useMatchStream(matchId);
  const { account } = useAccount();
  const lobby = useLobby();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("thinking");

  // The match is over, and the result belongs on this page, live. The page
  // decides which of the two it renders from the match row, which flips once
  // the chips have gone back (a moment after the feed says it is over), so it
  // is asked again until it does.
  useEffect(() => {
    if (!idleReason) return;
    let asked = 0;
    const timer = setInterval(() => {
      asked += 1;
      router.refresh();
      if (asked >= RESULT_CHECKS) clearInterval(timer);
    }, RESULT_CHECK_MS);
    return () => clearInterval(timer);
  }, [idleReason, router]);
  // Every agent this viewer owns. At most one of them sits at any given
  // table, because the matchmaker seats each owner once per table.
  const myAgentIds = new Set((account?.agents ?? []).map((agent) => agent.id));

  // Picking a tab leaves focus on the tab button, whose nearest scrollable
  // ancestor is the page, so the arrow keys scroll the page out from under the
  // panel the reader just asked for. Hand focus to the panel's own scroller,
  // when a tab was actually picked, so first paint leaves the reader wherever
  // they came in.
  const panel = useRef<HTMLDivElement>(null);
  const picked = useRef(false);
  useEffect(() => {
    if (!picked.current) return;
    panel.current
      ?.querySelector<HTMLElement>("[data-panel-scroll]")
      ?.focus({ preventScroll: true });
  }, [tab]);

  const brain: BrainState | null = table?.brain
    ? {
        seatName: table.brain.seatName,
        color: table.brain.color,
        street: table.brain.street,
        reasoning: table.brain.reasoning,
        streaming: isStreaming,
        sealed: table.brain.sealed,
        equity: table.brain.equity,
        potOdds: table.brain.potOdds,
        made: table.brain.handRead?.made ?? null,
        draws: drawsOf(table.brain.handRead),
        action: table.brain.action,
        amount: table.brain.amount ?? 0,
        failure: table.brain.failure,
        elapsedMs: table.brain.elapsedMs,
        say:
          table.seats.find((seat) => seat.index === table.brain?.seat)?.say ??
          null,
      }
    : null;

  /*
    The feed has refused long enough to call it. The page renders this
    component for a match the server said was still being dealt, so the
    remaining cause is that it is being dealt on another instance (a second web
    instance, or a deploy that has already handed the room over). Saying so
    gives the reader a clear answer.
  */
  if (gaveUp && !table) {
    return (
      <div className="page mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
        <Card className="p-6 text-center">
          <h1 className="text-lg font-semibold">This match is dealt elsewhere</h1>
          <p className="mt-2 text-sm text-muted">It may have just finished. Its result appears on the matches list.</p>
          <div className="mt-5 flex justify-center">
            <ButtonLink href="/matches">Back to matches</ButtonLink>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="page mx-auto w-full max-w-[104rem] px-4 py-4 sm:px-6 sm:py-6">
      <TableBar
        table={table}
        connected={connected}
        finished={idleReason !== null}
        seatedHere={lobby.mine.includes(matchId)}
      />

      <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_25rem]">
        <div className="min-w-0">
          <Felt
            table={table}
            myAgentIds={myAgentIds}
            idleReason={idleReason}
            moved={moved}
            potKey={potKey}
            actionKeys={actionKeys}
          />
        </div>

        {/*
          The panel is exactly as tall as the felt beside it. Its height comes from
          the stage, so switching to the hand log scrolls inside the panel and the
          table stays put under the reader.
        */}
        <Card className="flex h-[32rem] min-w-0 flex-col overflow-hidden lg:h-[var(--stage-h)]">
          {/*
            One tab stop for the row, and the arrow keys move along it, which
            is how every other tab row a keyboard user meets behaves. Arrowing
            keeps focus on the tabs, where a click hands it to the panel, so the next
            arrow moves to the next tab.
          */}
          <div
            role="tablist"
            aria-label="Table panels"
            className="flex shrink-0 border-b border-line"
            onKeyDown={(event) => {
              const current = TABS.findIndex((entry) => entry.id === tab);
              const next =
                event.key === "ArrowRight"
                  ? (current + 1) % TABS.length
                  : event.key === "ArrowLeft"
                    ? (current - 1 + TABS.length) % TABS.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? TABS.length - 1
                        : null;
              if (next === null) return;
              event.preventDefault();
              picked.current = false;
              setTab(TABS[next].id);
              document.getElementById(`tab-${TABS[next].id}`)?.focus();
            }}
          >
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                id={`tab-${entry.id}`}
                aria-controls={`panel-${entry.id}`}
                aria-selected={tab === entry.id}
                tabIndex={tab === entry.id ? 0 : -1}
                onClick={() => {
                  picked.current = true;
                  setTab(entry.id);
                }}
                className={`flex-1 border-b-2 px-3 py-2.5 text-[0.8125rem] font-medium transition-colors ${
                  tab === entry.id
                    ? "border-accent text-ink"
                    : "border-transparent text-muted hover:text-ink"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div
            ref={panel}
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
            className="min-h-0 flex-1"
          >
            {tab === "thinking" ? (
              <ThinkingPanel brain={brain} deadline={table?.deadline ?? null} />
            ) : tab === "players" ? (
              <PlayersPanel table={table} myAgentIds={myAgentIds} />
            ) : (
              <LogPanel table={table} />
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

/**
 * Everything you need to know about the table before you look at it. The way
 * back is here because this is a page people reach from a shared link and land
 * on cold. It is the one way back, and the one button on this strip.
 */
function TableBar({
  table,
  connected,
  finished,
  seatedHere,
}: {
  table: TableView | null;
  connected: boolean;
  finished: boolean;
  seatedHere: boolean;
}) {
  return (
    <div>
      <BackLink href="/matches">Matches</BackLink>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="display text-[1.75rem] text-ink sm:text-[2rem]">
              {table?.label ?? "Loading match…"}
            </h1>
            {finished ? (
              <Badge>Ended</Badge>
            ) : connected ? (
              <LiveBadge
                label={table && table.street !== "idle" ? "Live" : "Connected"}
              />
            ) : null}
            {seatedHere ? <Badge tone="accent">Your agent</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-muted">
            {table ? (
              <>
                {table.seatCount} agents · {table.smallBlind}/
                {table.bigBlind} blinds
                {table.handNumber > 0
                  ? ` · hand ${table.handNumber.toLocaleString("en-US")} of ${table.handCap.toLocaleString("en-US")}`
                  : ""}
              </>
            ) : (
              "Connecting to the match feed."
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Who is at the table, with the numbers a spectator checks between hands. */
function PlayersPanel({
  table,
  myAgentIds,
}: {
  table: TableView | null;
  myAgentIds: ReadonlySet<string>;
}) {
  const seats = table?.seats ?? [];

  return (
    <div className="scroll-y h-full p-3" data-panel-scroll tabIndex={0}>
      <ul className="space-y-1.5">
        {seats.map((seat) => {
          const mine = Boolean(seat.agentId && myAgentIds.has(seat.agentId));
          return (
            <li
              key={seat.index}
              className="flex items-center gap-3 rounded-control border border-line bg-surface-2 px-3 py-2.5"
            >
              <ChipDot
                color={mine ? "white" : seat.color}
                empty={!seat.agentId}
                size={16}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm text-ink">
                    {seat.agentId ? seatLabel(seat) : `Seat ${seat.index + 1}`}
                  </span>
                  {seat.isDealer ? <DealerButton size={13} /> : null}
                  {/* The seat is the agent, so it says Yours
                      the way the result table does. */}
                  {mine ? <Badge tone="accent">Yours</Badge> : null}
                </div>
                <p className="text-xs text-faint">
                  {seat.agentId
                    ? seat.status === "out"
                      ? "Eliminated"
                      : table?.toAct === seat.index
                        ? "Deciding now"
                        : seat.status === "folded"
                          ? "Folded this hand"
                          : seat.status === "all-in"
                            ? "All in"
                            : (moveWords(seat) ?? "Waiting")
                    : "Open seat"}
                </p>
              </div>
              {seat.agentId ? (
                <div className="text-right">
                  <div className="mono text-sm text-ink tabular-nums">
                    {formatChips(seat.stack)}
                  </div>
                  {/* Neutral like every other state figure. The chip beside
                      the name already says whose it is, and in some agents'
                      colours a bet would read as a loss. */}
                  {seat.committed > 0 ? (
                    <div className="mono text-xs text-muted tabular-nums">
                      {formatChips(seat.committed)} in
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Every action at this table, newest last, the way a hand history reads. */
function LogPanel({ table }: { table: TableView | null }) {
  const lines = table?.log ?? [];
  const scroller = useRef<HTMLDivElement>(null);

  // Scroll the log itself. The panel is a fixed height, and scrolling the log
  // directly keeps the page where it is.
  useEffect(() => {
    const box = scroller.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines.length]);

  return (
    <div
      ref={scroller}
      className="scroll-y h-full p-3"
      data-panel-scroll
      tabIndex={0}
    >
      {lines.length === 0 ? (
        <p className="px-1 py-8 text-center text-sm text-muted">
          The first action lands here.
        </p>
      ) : (
        <ol className="space-y-1">
          {lines.map((line) => (
            <li
              key={line.id}
              className="entering flex gap-2.5 rounded-[0.375rem] px-2 py-1.5 text-sm odd:bg-surface-2/60"
            >
              <span className="mono shrink-0 text-xs text-faint tabular-nums">
                {clock(line.at)}
              </span>
              <span className="min-w-0 text-muted">{line.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", {
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
  });
}
