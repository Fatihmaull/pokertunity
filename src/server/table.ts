import { cardName, type Card } from '../poker/cards';
import { applyAction, legalActions, startHand, totalPot, type HandState, type Street } from '../poker/engine';
import { describe as describeHand, evaluate } from '../poker/evaluate';
import { conservative } from '../lib/rating';
import { decide } from '../agent/decide';
import { OPPONENT_COLORS } from '../agent/colors';
import type { MatchConfig } from '../lib/economy';
import { matchLabel } from '../lib/format';
import {
  ACTION_BEAT_MS,
  ACT_CLOCK_MS,
  AWARD_BEAT_MS,
  BETWEEN_HANDS_MS,
  HAND_END_BEAT_MS,
  REVEAL_BEAT_MS,
  SHOWDOWN_BEAT_MS,
  STREET_BEAT_MS,
  STREET_SETTLE_MS,
  pacingFloor,
} from '../lib/pacing';
import { wait } from '../lib/wait';
import { TableBus } from './bus';
import { shuffledDeck } from './deck';
import {
  clearInHand,
  loadSeats,
  markInHand,
  ratingsOf,
  recordHand,
  type HandOutcome,
  type MatchEnding,
  type RecordedDecision,
  type SeatedAgent,
} from './store';
import { linkFor } from './presence';
import type { ArenaEvent, BrainView, LogLine, SeatStatus, SeatView, TableView } from './view';

export class MatchRuntime {
  readonly bus = new TableBus();

  private seated: SeatedAgent[] = [];
  private state: HandState | null = null;
  /**
   * The seats in this hand, in engine order. The engine numbers seats densely
   * from zero; the table numbers them by chair, and chairs go sparse as soon as
   * anyone in the middle busts out. This array is the one bridge between the
   * two, and everything else treats the numberings as distinct.
   */
  private lineup: SeatedAgent[] = [];
  /** Colour to draw each chair in, after resolving collisions at this table. */
  private palette = new Map<number, string>();
  private handNumber = 0;
  /** The button follows a chair, so it survives a bust renumbering the lineup. */
  private buttonChair = -1;
  /** How the match ended, once it has. Null while it is still being played. */
  private ending: MatchEnding | null = null;
  private toAct: number | null = null;
  private deadline: number | null = null;
  private brain: BrainView | null = null;
  /** Whether `brain` may be shown whole. A showdown opens it. */
  private brainOpen = false;
  /** The last decision each chair made this hand, whole, for opening at a showdown. */
  private decided = new Map<number, BrainView>();
  private shown = new Map<number, Card[]>();
  private timing = new Map<number, { elapsedMs: number; action: string; to: number }>();
  /** What each chair won this hand, so a snapshot mid-award still shows it. */
  private won = new Map<number, number>();
  /** Blinds posted this hand. Posting one is separate from acting, so it is kept apart. */
  private blinds = new Map<number, { kind: 'small' | 'big'; amount: number }>();
  private talk = new Map<number, string>();
  private log: LogLine[] = [];
  private logSequence = 0;
  /** Ratings of everyone in the match, read once when it opens. */
  private ratings = new Map<string, number>();
  private running = false;
  private stopping = new AbortController();

  constructor(
    readonly matchId: string,
    readonly number: number,
    readonly config: MatchConfig,
    /** Called once the match is over, so the matchmaker can close it out. */
    private readonly onFinished: (matchId: string, ending: MatchEnding, hands: number) => void,
  ) {}

  /**
   * Reads the roster once, when the match opens.
   *
   * The set of agents is fixed from the first hand to the last, which is the
   * whole reason a finishing order means anything.
   */
  private async loadRoster(): Promise<void> {
    this.seated = await loadSeats(this.matchId);
    this.ratings = new Map(
      [...(await ratingsOf(this.seated.map((seat) => seat.agentId)))].map(
        ([agentId, rating]) => [agentId, conservative(rating)],
      ),
    );

    this.palette = tablePalette(this.seated);
    this.publish({ type: 'seats', seats: this.seatViews(null) });
    this.tellMatchStart();
  }

  /**
   * Tells every agent it has been seated, and who with.
   *
   * Sent once, because a match is fixed from the first hand to the last. An
   * agent that reconnects mid-match rebuilds everything that matters from the
   * next act frame, which describes the table as it is now.
   */
  private tellMatchStart(): void {
    const seats = this.seated.map((seat) => ({
      seat: seat.seatIndex,
      name: seat.name,
      stack: seat.stack,
    }));

    for (const seat of this.seated) {
      linkFor(seat.agentId)?.send({
        type: 'match-start',
        matchId: this.matchId,
        seat: seat.seatIndex,
        seats,
        smallBlind: this.config.smallBlind,
        bigBlind: this.config.bigBlind,
        buyIn: this.config.buyIn,
        handCap: this.config.handCap,
      });
    }
  }

  /** Engine position for a chair, or null when that chair sits this hand out. */
  private positionOf(chair: number): number | null {
    const position = this.lineup.findIndex((seat) => seat.seatIndex === chair);
    return position < 0 ? null : position;
  }

  /** Chair a given engine position is sitting in. */
  private chairOf(position: number): number {
    return this.lineup[position]?.seatIndex ?? position;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = new AbortController();
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.stopping.abort();
  }

  /**
   * The table as one viewer is entitled to see it. Hole cards belong to their
   * owner until a real showdown, so the redaction happens here, on the server,
   * where it is enforced.
   */
  view(viewerAgentId: string | null): TableView {
    return {
      matchId: this.matchId,
      label: matchLabel(this.number),
      seatCount: this.config.seats,
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      handCap: this.config.handCap,
      handNumber: this.handNumber,
      street: this.state ? this.state.street : 'idle',
      board: (this.state?.board ?? []).map(cardName),
      pot: this.state ? totalPot(this.state) : 0,
      seats: this.seatViews(viewerAgentId),
      toAct: this.toAct,
      deadline: this.deadline,
      remainingMs: this.deadline === null ? null : Math.max(0, this.deadline - Date.now()),
      brain: this.brain && !this.brainOpen ? sealBrain(this.brain) : this.brain,
      log: this.log.slice(-40),
    };
  }

  private seatViews(viewerAgentId: string | null): SeatView[] {
    return Array.from({ length: this.config.seats }, (_, index) => {
      const occupant = this.seated.find((seat) => seat.seatIndex === index);
      const position = this.positionOf(index);
      const live = position === null ? undefined : this.state?.seats[position];
      const timing = this.timing.get(index);

      if (!occupant) {
        return {
          index,
          agentId: null,
          name: null,
          color: null,
          stack: 0,
          committed: 0,
          status: 'empty' as SeatStatus,
          isDealer: false,
          hole: null,
          lastAction: null,
          lastActionTo: null,
          won: null,
          blind: null,
          say: null,
        };
      }

      const revealed = this.shown.get(index);
      const ownCards = viewerAgentId !== null && viewerAgentId === occupant.agentId;
      const hole = revealed ?? (ownCards && live?.hole ? [...live.hole] : null);

      return {
        index,
        agentId: occupant.agentId,
        name: occupant.name,
        color: this.palette.get(index) ?? occupant.color,
        stack: live?.stack ?? occupant.stack,
        committed: live?.committed ?? 0,
        status: occupant.bustedAtHand !== null ? 'out' : this.statusOf(index, live),
        isDealer: this.state !== null && position !== null && position === this.state.button,
        hole: hole ? hole.map(cardName) : null,
        lastAction: timing?.action ?? null,
        lastActionTo: timing?.to ?? null,
        won: this.won.get(index) ?? null,
        // A blind is a blind before the flop. After that the chips are in the pot,
        // and this street's line shows what the seat did on it.
        blind: this.state?.street === 'preflop' ? (this.blinds.get(index) ?? null) : null,
        say: this.talk.get(index) ?? null,
      };
    });
  }

  private statusOf(index: number, live: HandState['seats'][number] | undefined): SeatStatus {
    if (!live) return 'waiting';
    if (live.folded) return 'folded';
    if (live.allIn) return 'all-in';
    if (this.toAct === index) return 'thinking';
    return live.hasActed ? 'acted' : 'waiting';
  }

  private publish(event: ArenaEvent): void {
    this.bus.publish(event);
  }

  private note(text: string): void {
    const line: LogLine = { id: ++this.logSequence, at: Date.now(), text };
    this.log.push(line);
    if (this.log.length > 200) this.log.shift();
    this.publish({ type: 'log', line });
  }

  private pause(ms: number): Promise<void> {
    return wait(ms, this.stopping.signal);
  }

  private async loop(): Promise<void> {
    try {
      await this.loadRoster();
    } catch (error) {
      console.error(`[${this.matchId}] cannot read the roster`, error);
      this.finish('abandoned');
      return;
    }

    while (this.running) {
      // Everyone but one is out of chips. That is the match, and it ends the
      // moment it happens.
      if (this.alive().length < 2) {
        this.finish('elimination');
        return;
      }

      if (this.handNumber >= this.config.handCap) {
        this.finish('cap');
        return;
      }

      try {
        await this.playHand();
      } catch (error) {
        // Spectators get a plain sentence; the detail goes to the server log,
        // because a driver's error text belongs in the log.
        console.error(`[${this.matchId}] hand ${this.handNumber} abandoned`, error);
        this.note('That hand was abandoned mid-play.');
      } finally {
        // Whatever happened, the hand has let go of its chips. Clearing the
        // marks here keeps the match going, because this is where they get
        // cleared.
        await clearInHand(this.matchId).catch((error) => {
          console.error(`[${this.matchId}] could not release the seats`, error);
        });
      }

      await this.pause(BETWEEN_HANDS_MS);
    }
  }

  /** Seats that still have chips to play with. */
  private alive(): SeatedAgent[] {
    return this.seated.filter((seat) => seat.bustedAtHand === null && seat.stack >= this.config.bigBlind);
  }

  /**
   * Stops dealing and hands the match back to be settled.
   *
   * The settling itself happens outside this runtime, because it moves chips
   * and updates ratings, and that work stays apart from the loop that deals
   * cards.
   */
  private finish(ending: MatchEnding): void {
    if (this.ending !== null) return;
    this.ending = ending;
    this.running = false;

    this.state = null;
    this.toAct = null;
    this.deadline = null;
    this.note(
      ending === 'elimination'
        ? 'One agent has everything. That is the match.'
        : ending === 'cap'
          ? `The hand limit is up after ${this.handNumber} hands.`
          : 'The match was abandoned.',
    );
    this.publish({ type: 'idle', reason: 'This match is over.' });

    this.onFinished(this.matchId, ending, this.handNumber);
  }

  private async playHand(): Promise<void> {
    // Seats with chips left. Everyone else is eliminated and stays on the
    // record of where they finished.
    const seated = this.alive().sort((a, b) => a.seatIndex - b.seatIndex);

    // Claimed on the rows before a card exists, so the hand owns these seats
    // before it bets with them. A seat that could not be claimed is dropped, so
    // every seat dealt to comes from a fresh read.
    const claimed = new Set(await markInHand(this.matchId, seated.map((seat) => seat.seatIndex)));
    const lineup = seated.filter((seat) => claimed.has(seat.seatIndex));
    if (lineup.length < 2) {
      await clearInHand(this.matchId);
      this.finish('elimination');
      return;
    }

    this.lineup = lineup;

    // From a CSPRNG: see `shuffledDeck` for what a seed would hand to an agent
    // that goes looking for it.
    const deck = shuffledDeck();
    const startedAt = new Date();

    this.handNumber += 1;
    // The button moves to the next occupied chair, so a seat emptying between
    // deals still gives every player the button once and their blinds in turn.
    const button = nextButtonPosition(lineup, this.buttonChair);
    this.buttonChair = lineup[button].seatIndex;
    this.shown.clear();
    this.timing.clear();
    this.talk.clear();
    this.won.clear();
    this.blinds.clear();
    this.decided.clear();
    this.brain = null;
    this.brainOpen = false;

    let state = startHand({
      handId: `${this.matchId}-${this.handNumber}`,
      seats: lineup.map((seat) => ({ agentId: seat.agentId, stack: seat.stack })),
      button,
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      deck,
    });
    this.state = state;

    // Who was made to post what, so a seat still waiting to act has something
    // true to show.
    for (const event of state.events) {
      if (event.type !== 'blind') continue;
      this.blinds.set(this.chairOf(event.seat), { kind: event.kind, amount: event.amount });
    }

    this.note(`Hand ${this.handNumber} dealt. Blinds ${this.config.smallBlind}/${this.config.bigBlind}.`);
    this.publish({
      type: 'hand-start',
      handNumber: this.handNumber,
      button: this.buttonChair,
      seats: this.seatViews(null),
    });

    const recorded: RecordedDecision[] = [];
    let eventCursor = state.events.length;
    let street: Street = state.street;

    while (state.toAct !== null && this.running) {
      const position = state.toAct;
      const chair = this.chairOf(position);
      const agent = lineup[position];
      if (!agent) throw new Error(`seat ${position} has no agent`);
      const color = this.palette.get(chair) ?? agent.color;

      const legal = legalActions(state)!;
      const potOdds = legal.toCall > 0 ? legal.toCall / (legal.potSize + legal.toCall) : null;

      this.toAct = chair;
      this.deadline = Date.now() + ACT_CLOCK_MS;
      this.brain = {
        seat: chair,
        seatName: agent.name,
        color,
        street: state.street,
        reasoning: '',
        equity: null,
        handRead: null,
        potOdds,
        action: null,
        amount: null,
        failure: null,
        elapsedMs: null,
        sealed: false,
      };
      this.brainOpen = false;
      this.publish({
        type: 'to-act',
        seat: chair,
        seatName: agent.name,
        color,
        // The browser keeps its own clock. Sending what is left lets the arena
        // count down against its own clock.
        remainingMs: ACT_CLOCK_MS,
        potOdds,
        street: state.street,
      });

      const record = await decide({
        // Resolved on demand. An agent can drop and reconnect
        // inside a single decision, and the connection that comes back is a
        // different object from the one that left.
        link: () => linkFor(agent.agentId) ?? null,
        state,
        seatIndex: position,
        clockMs: ACT_CLOCK_MS,
        matchId: this.matchId,
        handNumber: this.handNumber,
        chairs: lineup.map((seat) => seat.seatIndex),
        opponentNames: new Map(lineup.map((seat) => [seat.agentId, seat.name])),
        opponentTiming: new Map([...this.timing].map(([chair, entry]) => [chair, entry.elapsedMs])),
        signal: this.stopping.signal,
        // Kept on the runtime, private. Both describe the cards this seat is
        // holding, in a hand that is still being played.
        onEquity: (equity, read) => {
          if (this.brain?.seat === chair) {
            this.brain.equity = equity.equity;
            this.brain.handRead = read;
          }
        },
        onToken: (delta) => {
          if (this.brain?.seat === chair) this.brain.reasoning += delta;
        },
      });

      // Hesitation is information, so a close decision is held on screen longer
      // than a routine one. The model's own latency counts toward the floor.
      await this.pause(pacingFloor(record.equity.equity, potOdds) - record.elapsedMs);

      state = applyAction(state, record.action);
      this.state = state;

      const seatState = state.seats[position];
      const applied = lastActionEvent(state, eventCursor);
      this.timing.set(chair, {
        elapsedMs: record.elapsedMs,
        action: applied?.action ?? record.action.type,
        to: applied?.to ?? 0,
      });
      if (record.say) this.talk.set(chair, record.say);

      this.brain = {
        seat: chair,
        seatName: agent.name,
        color,
        street,
        reasoning: record.reasoning,
        equity: record.equity.equity,
        handRead: record.read,
        potOdds,
        action: applied?.action ?? record.action.type,
        amount: applied?.amount ?? 0,
        failure: record.failure,
        elapsedMs: record.elapsedMs,
        sealed: false,
      };
      this.decided.set(chair, this.brain);

      this.publish({
        type: 'decision',
        seat: chair,
        action: applied?.action ?? record.action.type,
        amount: applied?.amount ?? 0,
        to: applied?.to ?? 0,
        failure: record.failure,
        elapsedMs: record.elapsedMs,
        say: record.say,
        stack: seatState.stack,
        committed: seatState.committed,
        pot: totalPot(state),
      });

      this.note(
        describeAction(agent.name, applied?.action ?? record.action.type, applied?.amount ?? 0, applied?.to ?? 0),
      );
      // Stored hands are indexed by engine position, which is what the lineup
      // written alongside them is indexed by.
      recorded.push({ seatIndex: position, agentId: agent.agentId, record, street, amount: amountOf(state, eventCursor) });

      // The decision stays alone on screen long enough to read who acted and for
      // how much, before the next seat's clock starts.
      await this.pause(ACTION_BEAT_MS);

      eventCursor = await this.flushBoardEvents(state, eventCursor);
      street = state.street === 'complete' ? street : state.street;
      this.toAct = state.toAct === null ? null : this.chairOf(state.toAct);
      this.deadline = null;
    }

    await this.flushBoardEvents(state, eventCursor);
    this.toAct = null;
    this.deadline = null;

    // Shutting down mid-hand leaves chips in the pot, between seats. The hand
    // is abandoned and the stored stacks, which still hold every chip, stand as
    // they are.
    if (state.toAct !== null) {
      this.note('The table stopped mid-hand, and that hand is void.');
      return;
    }

    await this.settleOnScreen(state, lineup);
    // Told before the stacks are written back, because persisting rewrites the
    // roster's stacks in place and the frame needs what each seat came in with
    // to say what the hand cost them.
    this.tellHandResult(lineup, state);
    await this.persist({ lineup, state, deck, startedAt, recorded });
  }

  /**
   * Tells every agent in the hand how it ended.
   *
   * Exactly what the table saw. The engine already decided who had to show, so
   * the mucked hands stay mucked here too, private from opponents still sitting
   * in the same match.
   */
  private tellHandResult(lineup: SeatedAgent[], state: HandState): void {
    const shown = state.events
      .filter((event) => event.type === 'showdown')
      .map((event) => ({
        seat: this.chairOf(event.seat),
        name: lineup[event.seat]?.name ?? `seat ${event.seat + 1}`,
        hole: event.hole.map(cardName) as [string, string],
      }));

    const pots = new Map<number, number>();
    for (const event of state.events) {
      if (event.type === 'award') pots.set(event.seat, (pots.get(event.seat) ?? 0) + event.amount);
    }
    const winners = [...pots].map(([position, amount]) => ({
      seat: this.chairOf(position),
      name: lineup[position]?.name ?? `seat ${position + 1}`,
      amount,
    }));

    const board = state.board.map(cardName);
    const showdown = shown.length > 0;

    for (const [position, seat] of lineup.entries()) {
      const link = linkFor(seat.agentId);
      if (!link) continue;

      const finished = state.seats[position];
      link.send({
        type: 'hand-result',
        matchId: this.matchId,
        handNumber: this.handNumber,
        board,
        net: finished.stack - seat.stack,
        stack: finished.stack,
        showdown,
        shown,
        winners,
      });
    }
  }

  /** Streets and showdowns land as their own beats. */
  private async flushBoardEvents(state: HandState, cursor: number): Promise<number> {
    for (let i = cursor; i < state.events.length; i++) {
      const event = state.events[i];
      if (event.type === 'street') {
        await this.pause(STREET_BEAT_MS);
        this.publish({
          type: 'street',
          street: event.street,
          cards: event.cards.map(cardName),
          pot: totalPot(state),
        });
        this.note(`${capitalise(event.street)}: ${event.cards.map(cardName).join(' ')}`);
        // The bets have just swept into the pot and the new cards have landed.
        // Both are the reason the next decision reads the way it does, so both
        // stay on screen before it arrives.
        await this.pause(STREET_SETTLE_MS);
      }
    }
    return state.events.length;
  }

  private async settleOnScreen(state: HandState, lineup: SeatedAgent[]): Promise<void> {
    const showdowns = state.events.filter((event) => event.type === 'showdown');
    if (showdowns.length > 0) await this.pause(SHOWDOWN_BEAT_MS);

    for (const event of showdowns) {
      if (event.type !== 'showdown') continue;
      const chair = this.chairOf(event.seat);
      this.shown.set(chair, [...event.hole]);
      const hand = describeHand(evaluate([...event.hole, ...state.board]));
      this.publish({ type: 'showdown', seat: chair, hole: event.hole.map(cardName) });
      this.note(`${lineup[event.seat]?.name ?? 'Seat'} shows ${event.hole.map(cardName).join(' ')}, ${hand}.`);

      // The cards are face up, so what the seat thought of them repeats what the
      // table has just shown. A seat that went all in on a blind made zero
      // decisions this hand, so its brain stays empty.
      const brain = this.decided.get(chair);
      if (brain) {
        this.brain = brain;
        this.brainOpen = true;
        this.publish({ type: 'reveal', brain });
      }
      await this.pause(REVEAL_BEAT_MS);
    }

    // Held after every hand, because a pot won uncontested is
    // still a pot being pushed and it is the last thing to happen this hand.
    await this.pause(AWARD_BEAT_MS);

    for (const event of state.events) {
      if (event.type !== 'award') continue;
      const chair = this.chairOf(event.seat);
      this.won.set(chair, (this.won.get(chair) ?? 0) + event.amount);
      this.publish({
        type: 'award',
        seat: chair,
        amount: event.amount,
        stack: state.seats[event.seat].stack,
      });
      this.note(`${lineup[event.seat]?.name ?? 'Seat'} wins ${event.amount}.`);
    }

    // The pot has just been pushed. The pause lets a spectator see it land
    // before the board clears.
    await this.pause(HAND_END_BEAT_MS);

    this.publish({
      type: 'hand-end',
      stacks: state.seats.map((seat) => ({ seat: this.chairOf(seat.index), stack: seat.stack })),
    });
  }

  private async persist(context: {
    lineup: SeatedAgent[];
    state: HandState;
    deck: readonly Card[];
    startedAt: Date;
    recorded: RecordedDecision[];
  }): Promise<void> {
    const { lineup, state, deck, startedAt, recorded } = context;
    const dealtIn = state.seats.filter((seat) => !seat.sittingOut);
    const showdown = state.events.some((event) => event.type === 'showdown');

    const outcomes: HandOutcome[] = lineup.flatMap((seat, position) => {
      const finished = state.seats[position];
      if (finished.sittingOut) return [];

      const net = finished.stack - seat.stack;
      return [
        {
          agentId: seat.agentId,
          won: net > 0,
          net,
          startingStack: seat.stack,
          showdown,
          opponents: dealtIn.length - 1,
          // A snapshot of how strong the opposition was, taken now rather
          // than joined later, because ratings move and asking next month how
          // good these opponents were would answer with next month's opinion.
          opponentRating: averageRating(
            dealtIn
              .filter((other) => other.index !== position)
              .map((other) => this.ratings.get(lineup[other.index]?.agentId ?? '')),
          ),
        },
      ];
    });

    // One transaction: the hand, its results and counters, the stacks it left
    // and the seats it knocked out. If it fails, it all rolls back, which is
    // what lets the table carry on from the stacks it already holds.
    await recordHand({
      matchId: this.matchId,
      handNumber: this.handNumber,
      deck,
      state,
      startedAt,
      bigBlind: this.config.bigBlind,
      lineup: lineup.map((seat, position) => ({
        seatIndex: position,
        chair: seat.seatIndex,
        agentId: seat.agentId,
        name: seat.name,
        startingStack: seat.stack,
      })),
      decisions: recorded,
      outcomes,
    });

    // Carry the result back onto the roster this runtime deals from.
    //
    // The roster is read once, when the match opens, because it is fixed from
    // then on, so this is where it gets updated: it is what deals each hand
    // from the stacks the last one left and keeps chips conserved. The lineup
    // entries are the same objects as the roster's, so assigning here is what
    // makes hand two follow from hand one. After the commit, so the roster
    // always matches the record it will be settled from.
    for (const [position, seat] of lineup.entries()) {
      seat.stack = state.seats[position].stack;
    }

    // A stack short of the big blind is out. Every entrant stays in the match
    // record, so an eliminated seat stays where it is with its finishing
    // hand recorded, which is what fixes the order among everyone who went out.
    for (const seat of lineup) {
      if (seat.stack >= this.config.bigBlind) continue;

      seat.bustedAtHand = this.handNumber;
      this.note(
        seat.stack > 0
          ? `${seat.name} is down to ${seat.stack}, short of a blind, finishing on hand ${this.handNumber}.`
          : `${seat.name} is out of chips, finishing on hand ${this.handNumber}.`,
      );
    }
  }
}

/**
 * A decision as the public feed may show it while its hand is live: who, when,
 * at what price and what it did. What describes the cards waits for `reveal`.
 */
function sealBrain(brain: BrainView): BrainView {
  return { ...brain, reasoning: '', equity: null, handRead: null, sealed: true };
}

/** Mean of the ratings we have, over the opponents that carry one. */
function averageRating(ratings: Array<number | undefined>): number {
  const known = ratings.filter((rating): rating is number => rating !== undefined);
  if (known.length === 0) return 0;
  return known.reduce((sum, rating) => sum + rating, 0) / known.length;
}

/**
 * The next button position, following the chair the button was last in.
 *
 * Rotating a position instead would move the button by whatever the lineup
 * happens to be numbered today, which hands the same player the button twice
 * whenever a seat empties.
 */
function nextButtonPosition(lineup: SeatedAgent[], lastChair: number): number {
  const after = lineup.findIndex((seat) => seat.seatIndex > lastChair);
  return after >= 0 ? after : 0;
}

/**
 * Chip colour per chair, with collisions broken at the table.
 *
 * An agent keeps the colour it owns wherever possible, because colour is
 * identity. Two agents that happen to own the same colour each need their own
 * at one felt, so the later chair takes the first colour still free here.
 */
export function tablePalette(seated: SeatedAgent[]): Map<number, string> {
  const palette = new Map<number, string>();
  const used = new Set<string>();

  for (const seat of [...seated].sort((a, b) => a.seatIndex - b.seatIndex)) {
    const free = used.has(seat.color)
      ? (OPPONENT_COLORS.find((color) => !used.has(color.id))?.id ?? seat.color)
      : seat.color;
    used.add(free);
    palette.set(seat.seatIndex, free);
  }

  return palette;
}

function lastActionEvent(state: HandState, from: number): { action: string; amount: number; to: number } | null {
  for (let i = state.events.length - 1; i >= from; i--) {
    const event = state.events[i];
    if (event.type === 'action') return { action: event.action, amount: event.amount, to: event.to };
  }
  return null;
}

/**
 * What the action applied since `from` came to: the level reached for a bet or
 * a raise, the chips put in for a call, zero for a check or a fold.
 *
 * Read off that action's own event, at the moment it happened, so a seat that
 * called twice is stored with each call's own amount.
 */
export function amountOf(state: HandState, from: number): number {
  const applied = lastActionEvent(state, from);
  if (!applied) return 0;
  return applied.action === 'bet' || applied.action === 'raise' ? applied.to : applied.amount;
}

/**
 * One line of the hand log.
 *
 * A call is the chips it put in; a bet or a raise is the level it put the seat
 * at, which is how a table says it. "Raises 1990" for a blind shoving to 2,000
 * would read as a raise of 1,990 on top of something, so the level is what
 * the log says.
 */
export function describeAction(name: string, action: string, amount: number, to: number): string {
  switch (action) {
    case 'fold':
      return `${name} folds.`;
    case 'check':
      return `${name} checks.`;
    case 'call':
      return `${name} calls ${amount}.`;
    case 'bet':
      return `${name} bets ${to}.`;
    case 'raise':
      return `${name} raises to ${to}.`;
    default:
      return `${name} acts.`;
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
