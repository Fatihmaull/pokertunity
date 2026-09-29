import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Chip amounts are integers everywhere. Wei amounts are stored as text because
 * they exceed what a double can hold exactly, and are read back as bigint.
 */

export const depositStatus = pgEnum('deposit_status', ['pending', 'credited', 'expired', 'rejected']);
export const ledgerReason = pgEnum('ledger_reason', [
  'deposit',
  'grant',
  'match-buy-in',
  'match-cash-out',
  'entry-fee',
  'adjustment',
]);
export const decisionOutcome = pgEnum('decision_outcome', ['decided', 'timeout', 'error']);

/**
 * How a match stopped.
 *
 * `elimination` is one agent left holding everything. `cap` is the hand limit
 * arriving with several still alive. `abandoned` is the process that was
 * dealing going away mid-match, which returns every stack and rates nobody.
 */
export const matchStatus = pgEnum('match_status', ['waiting', 'playing', 'elimination', 'cap', 'abandoned']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Lowercase checksum-stripped address. One account per wallet. */
    address: text('address').notNull(),
    chips: integer('chips').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_address_idx').on(table.address)],
);

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Every agent has an owner, whose balance its buy-in comes out of. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Chip colour that identifies this agent at every table. */
    color: text('color').notNull(),
    /**
     * SHA-256 of the token this agent connects with. Never the token itself:
     * a database that leaks should not hand out working credentials, and an
     * owner who loses theirs rotates rather than asks us to look it up.
     */
    tokenHash: text('token_hash').notNull(),
    /** Last time a socket for this agent was open. Null if it has never connected. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    /**
     * Why the last connection ended, in a sentence.
     *
     * Kept because the alternative is an owner watching their agent silently
     * fail to appear with no way to find out whether the arena refused it, its
     * token was wrong, or it flooded the socket.
     */
    lastCloseReason: text('last_close_reason'),
    /**
     * What we think this agent is worth, and how sure we are of it.
     *
     * Kept on the row rather than recomputed from match results, because a
     * rating is path-dependent: it is the running product of every update in
     * the order they happened, so it cannot be derived from a set of rows the
     * way a win rate can. The match results table keeps the before and after of
     * every update, which is what makes it auditable anyway.
     */
    ratingMu: real('rating_mu').notNull().default(25),
    ratingSigma: real('rating_sigma').notNull().default(25 / 3),
    /** Matches finished. What the rating's confidence is really counting. */
    matchesPlayed: integer('matches_played').notNull().default(0),
    handsPlayed: integer('hands_played').notNull().default(0),
    handsWon: integer('hands_won').notNull().default(0),
    /** Net chips won across every hand. Negative is a losing agent. */
    chipsWon: bigint('chips_won', { mode: 'number' }).notNull().default(0),
    biggestPot: integer('biggest_pot').notNull().default(0),
    /**
     * Whether its owner lets it be seated.
     *
     * Saying `ready` on the socket is the agent asking; this is the owner
     * agreeing. Off for a new agent, so the first time somebody points freshly
     * written code at the arena it connects and can be watched answering, but is
     * not charged a seat until its owner decides it is fit to play one.
     *
     * Agents that existed before the switch did were already playing, and were
     * left on: the column arrived defaulting to true and was flipped to false in
     * a second migration, so turning it off is a choice nobody made for them.
     */
    queueEnabled: boolean('queue_enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Not unique any more. An owner may run several agents, because a team
    // testing three strategies should not have to be three people. What stops
    // that becoming collusion is the matchmaker, which refuses to seat two
    // agents of one owner at the same table.
    index('agents_user_idx').on(table.userId),
    uniqueIndex('agents_token_idx').on(table.tokenHash),
  ],
);

/** Chips the operator issued against a deposit that has not landed yet. */
export const depositIntents = pgTable(
  'deposit_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** EIP-155 id of the chain this deposit settles on. Always written explicitly. */
    chainId: integer('chain_id').notNull(),
    packageId: text('package_id').notNull(),
    chips: integer('chips').notNull(),
    expectedWei: text('expected_wei').notNull(),
    status: depositStatus('status').notNull().default('pending'),
    /** Set once the on-chain event has been read back and credited. */
    txHash: text('tx_hash'),
    blockNumber: bigint('block_number', { mode: 'number' }),
    /**
     * Which of the transaction's logs paid this intent. Null until credited:
     * the hash is written the moment the wallet returns it, the log only once
     * the receipt has been read.
     */
    logIndex: integer('log_index'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    creditedAt: timestamp('credited_at', { withTimezone: true }),
  },
  (table) => [
    // One credit per deposit event, enforced by the database rather than by
    // whatever the indexer believes it has already seen. Scoped to the chain
    // because a hash is only unique within one, and to the log because one
    // transaction can carry several deposits: keyed on the hash alone, the
    // second intent a batching wallet paid in the same call could never be
    // credited, and the player's money sat in the vault against nothing.
    // Rows noted before confirmation have no log yet, and Postgres counts
    // those nulls as distinct, so noting a hash never collides.
    uniqueIndex('deposit_intents_tx_idx').on(table.chainId, table.txHash, table.logIndex),
    index('deposit_intents_status_idx').on(table.status),
  ],
);

/**
 * The ERC-8004 identity minted for an agent, one per chain.
 *
 * One row per chain rather than a column on the agent, because the same agent
 * is registered on every chain the arena settles on and each mint hands back
 * its own token id. All of them point at the same registration file, which
 * lists every one, so a reader on any chain finds the others.
 *
 * Written only by `pnpm attest`, never on sign-up: an identity nobody has played
 * a hand under is a name with no record behind it, which is exactly the kind of
 * empty entry the registries already have too many of.
 */
export const agentIdentities = pgTable(
  'agent_identities',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** EIP-155 id of the chain it was minted on. */
    chainId: integer('chain_id').notNull(),
    /**
     * The Identity Registry it lives in, as it was when minted.
     *
     * Stored rather than read from configuration, because the registration file
     * has to name the registry that actually holds the token, and a later change
     * to an environment variable does not move a token that already exists.
     */
    registry: text('registry').notNull(),
    /** The token id, as a decimal string: a uint256 exceeds what a double holds exactly. */
    registryId: text('registry_id').notNull(),
    registerTx: text('register_tx').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.chainId] }),
    uniqueIndex('agent_identities_token_idx').on(table.chainId, table.registry, table.registryId),
  ],
);

/**
 * Every record this arena has published to ERC-8004.
 *
 * Kept because an attestation is a claim made in public: the hash on chain has
 * to be checkable against the document that was current when it was posted, and
 * a row here is what says which document that was. Append-only, so a later
 * attestation supersedes an earlier one rather than erasing it.
 */
export const attestations = pgTable(
  'attestations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** EIP-155 id of the chain it was published to. Always written explicitly. */
    chainId: integer('chain_id').notNull(),
    /** The ERC-8004 token id, as a decimal string. */
    registryId: text('registry_id').notNull(),
    /** Matches the published rating was earned over. */
    matches: integer('matches').notNull(),
    /** The published rating, at two decimal places. */
    rating: integer('rating').notNull(),
    ratingMu: real('rating_mu').notNull(),
    ratingSigma: real('rating_sigma').notNull(),
    /** How far the rating's doubt has closed, 0 to 100. Also sent to the Validation Registry where the chain has one. */
    confidence: integer('confidence').notNull(),
    /** KECCAK-256 of the canonical evidence document, as it went on chain. */
    evidenceHash: text('evidence_hash').notNull(),
    /** The document itself, as published, so the hash stays checkable. */
    evidence: jsonb('evidence').notNull(),
    /**
     * The transactions, filled in as each is mined.
     *
     * The row is written before anything is sent, because the URI that goes on
     * chain names this row: a record posted by a process that then died would
     * otherwise point at evidence that was never stored. A row with no
     * reputation transaction is therefore not a published attestation.
     */
    reputationTx: text('reputation_tx'),
    /** Null where the chain has no Validation Registry. */
    validationTx: text('validation_tx'),
    validationResponseTx: text('validation_response_tx'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('attestations_agent_idx').on(table.agentId, table.createdAt)],
);

/** Append-only record of every chip movement. The users.chips column is a cache of this. */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    reason: ledgerReason('reason').notNull(),
    reference: text('reference'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ledger_user_idx').on(table.userId, table.createdAt)],
);

/**
 * One game, from the moment it is dealt to the moment it is rated.
 *
 * A match is the unit of everything now. Seats belong to it, hands belong to
 * it, and it is what a rating is computed from. Once it
 * starts nobody joins and nobody leaves, so the set of agents in it is fixed
 * for its whole life, which is what makes a finishing order mean anything.
 */
export const matches = pgTable(
  'matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: matchStatus('status').notNull().default('waiting'),
    /** Copied in rather than read from configuration, so a finished match still describes itself. */
    seatCount: integer('seat_count').notNull(),
    smallBlind: integer('small_blind').notNull(),
    bigBlind: integer('big_blind').notNull(),
    buyIn: integer('buy_in').notNull(),
    entryFee: integer('entry_fee').notNull(),
    handCap: integer('hand_cap').notNull(),
    handsPlayed: integer('hands_played').notNull().default(0),
    /** Average published rating of the entrants when it started, for the lobby. */
    bandRating: real('band_rating'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [index('matches_status_idx').on(table.status, table.createdAt)],
);

/**
 * How one agent finished one match, and what that did to its rating.
 *
 * The before and after are both stored so a rating can be audited without
 * replaying every match anybody ever played. It is also the only place the
 * finishing order survives, since stacks are returned and seats deleted the
 * moment a match ends.
 */
export const matchResults = pgTable(
  'match_results',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** 1 is the winner. Equal numbers are a tie on chips at the cap. */
    place: integer('place').notNull(),
    /**
     * The chair this agent played, copied off the seat before it is deleted.
     *
     * Settling deletes the seats, so without this a finished match cannot say
     * who sat where and the lobby draws a table of empty chairs for a game six
     * agents actually played. Nullable because rows written before it existed
     * genuinely do not know, and inventing a chair for them would be worse than
     * admitting the gap.
     */
    seatIndex: integer('seat_index'),
    /** Chips in front of it when the match ended. Zero for anyone eliminated. */
    finalStack: integer('final_stack').notNull(),
    /** Hand number it went out on, or null for anyone still alive at the end. */
    bustedAtHand: integer('busted_at_hand'),
    ratingMuBefore: real('rating_mu_before').notNull(),
    ratingSigmaBefore: real('rating_sigma_before').notNull(),
    ratingMuAfter: real('rating_mu_after').notNull(),
    ratingSigmaAfter: real('rating_sigma_after').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('match_results_agent_idx').on(table.agentId, table.id),
    uniqueIndex('match_results_match_agent_idx').on(table.matchId, table.agentId),
  ],
);

/** An agent occupying a seat in a match. */
export const seats = pgTable(
  'seats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    seatIndex: integer('seat_index').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    stack: integer('stack').notNull(),
    /** Hand this seat went broke on. Set once, and it is what fixes finishing order. */
    bustedAtHand: integer('busted_at_hand'),
    /**
     * True from the moment a hand's lineup is fixed until its result is stored.
     *
     * The chips in front of a seat belong to the hand while it is being played,
     * so paying that stack out would refund a buy-in the agent is busy losing
     * and mint the difference. Nobody can leave a match, so the only other
     * writer is the process that abandons matches after a restart, and it did
     * not deal the hand. The rule lives on the row, where that process can see
     * it, rather than in the memory of the one that went away.
     */
    inHand: boolean('in_hand').notNull().default(false),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('seats_match_seat_idx').on(table.matchId, table.seatIndex),
    // An agent plays one match at a time, so its stack is never split.
    uniqueIndex('seats_agent_idx').on(table.agentId),
  ],
);

/** A completed hand, stored whole so it can be replayed exactly. */
export const hands = pgTable(
  'hands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    handNumber: integer('hand_number').notNull(),
    /**
     * The seed a hand used to be shuffled from. Only on hands dealt before decks
     * were stored: a seed an agent can search for is a deck it can read, so no
     * hand is dealt from one any more.
     */
    seed: integer('seed'),
    /** The deck as dealt, off the end, from a CSPRNG. Null only on hands that carry a seed. */
    deck: jsonb('deck').$type<number[]>(),
    button: integer('button').notNull(),
    /** Agent identities and starting stacks, as dealt. */
    lineup: jsonb('lineup').notNull(),
    board: jsonb('board').notNull(),
    pots: jsonb('pots').notNull(),
    events: jsonb('events').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('hands_match_number_idx').on(table.matchId, table.handNumber),
    index('hands_ended_idx').on(table.endedAt),
  ],
);

/**
 * One row per decision an agent made, including the ones it failed to make.
 * This is what the Brain Visualizer replays, so a timeout is recorded as a
 * timeout rather than dressed up as a fold.
 */
export const decisions = pgTable(
  'decisions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    handId: uuid('hand_id')
      .notNull()
      .references(() => hands.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    seatIndex: integer('seat_index').notNull(),
    street: text('street').notNull(),
    /** Monte Carlo result at the moment of the decision. */
    equity: real('equity').notNull(),
    handRead: jsonb('hand_read').notNull(),
    reasoning: text('reasoning').notNull().default(''),
    /** Short line of table talk, if the agent offered one. */
    say: text('say'),
    action: text('action').notNull(),
    amount: integer('amount').notNull().default(0),
    elapsedMs: integer('elapsed_ms').notNull(),
    outcome: decisionOutcome('outcome').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('decisions_hand_idx').on(table.handId, table.id),
    // What the axes read by: one agent's own decisions, and every opponent's
    // preflop ones. Without it each of those is a scan of the largest table.
    index('decisions_agent_idx').on(table.agentId, table.street),
  ],
);

/**
 * One row per agent per hand: what the hand did to its stack.
 *
 * Every number the arena publishes is a query over this table rather than a
 * counter kept somewhere. A counter can only answer the question it was written
 * for, and it cannot be recomputed when the question changes; these rows can
 * answer a metric nobody has thought of yet, over hands already played.
 *
 * The big blind is copied in rather than joined, because a win rate is measured
 * in big blinds and a match carries its own, which is not guaranteed to be the
 * figure the arena uses today.
 */
export const results = pgTable(
  'results',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    handId: uuid('hand_id')
      .notNull()
      .references(() => hands.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    bigBlind: integer('big_blind').notNull(),
    startingStack: integer('starting_stack').notNull(),
    /** Chips won or lost. Nothing is taken out of a pot, so this is the whole story. */
    net: integer('net').notNull(),
    /**
     * Whether this hand was decided by comparing cards rather than by everyone
     * else folding. It is what separates a bluff that worked from a good hand
     * that got paid, and deriving it later would mean scanning every stored
     * event blob forever.
     */
    showdown: boolean('showdown').notNull().default(false),
    /** Players dealt in besides this one. */
    opponents: integer('opponents').notNull(),
    /**
     * Average published rating of those opponents when the hand was dealt.
     *
     * A snapshot rather than a join, because ratings move: asking today how
     * strong an opponent was last month would answer with today's opinion. This
     * is what the exploitation score is measured against, now that it means
     * beating genuinely weak players rather than beating four scripted ones.
     */
    opponentRating: real('opponent_rating').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('results_agent_idx').on(table.agentId, table.id),
    uniqueIndex('results_hand_agent_idx').on(table.handId, table.agentId),
  ],
);
