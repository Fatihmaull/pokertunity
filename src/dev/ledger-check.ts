import 'dotenv/config';
import postgres from 'postgres';

/**
 * Says whether every chip is where the ledger says it is.
 *
 * For the incident drill in PRELAUNCH D6 and for any time the books are in
 * doubt: run it before a restart and after, and the two answers should differ
 * only by hands played. Everything runs in one read-only transaction, so it is
 * safe against production and cannot fix anything it finds, which is the
 * point: a finding here is a question for a person, not something to paper
 * over.
 *
 * Exits non-zero when any check fails, so it can gate a script.
 */

interface Check {
  name: string;
  /** Why a failure matters, printed with it. */
  meaning: string;
  rows: readonly unknown[];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const checks: Check[] = [];
  let summary: Record<string, unknown> = {};

  try {
    await sql.begin('read only', async (tx) => {
      checks.push({
        name: 'cached balance matches the ledger',
        meaning: 'users.chips disagrees with the last balance_after written for that user',
        rows: await tx`
          with last as (
            select distinct on (user_id) user_id, balance_after
            from ledger_entries order by user_id, created_at desc, id desc
          )
          select u.id, u.chips, l.balance_after from users u left join last l on l.user_id = u.id
          where u.chips is distinct from coalesce(l.balance_after, 0) limit 20`,
      });

      checks.push({
        name: 'every entry continues from the one before',
        meaning: 'a balance changed without an entry, or an entry was written out of order',
        rows: await tx`
          select user_id, id, delta, balance_after, prev from (
            select user_id, id, delta, balance_after,
                   lag(balance_after) over (partition by user_id order by created_at, id) prev
            from ledger_entries) t
          where prev is not null and prev + delta <> balance_after limit 20`,
      });

      checks.push({
        name: 'no negative balances',
        meaning: 'a seat was charged to an account that could not cover it',
        rows: await tx`select id, chips from users where chips < 0 limit 20`,
      });

      checks.push({
        name: 'no stacks left on a closed match',
        meaning: 'chips are sitting on a table nobody is dealing and have not gone home',
        rows: await tx`
          select m.id, m.status, count(*)::int seats, sum(s.stack)::int chips
          from seats s join matches m on m.id = s.match_id
          where m.status not in ('waiting', 'playing') group by m.id, m.status`,
      });

      // Buy-ins in and cash-outs back are the same chips moving through a
      // table. Across every finished match the two must cancel exactly; the
      // entry fee is the only sink, and it is booked separately.
      const [flow] = await tx`
        select coalesce(sum(delta) filter (where reason = 'match-buy-in'), 0)::bigint buy_ins,
               coalesce(sum(delta) filter (where reason = 'match-cash-out'), 0)::bigint cash_outs,
               coalesce(sum(delta) filter (where reason = 'entry-fee'), 0)::bigint fees,
               coalesce(sum(delta) filter (where reason = 'grant'), 0)::bigint grants,
               coalesce(sum(delta) filter (where reason = 'deposit'), 0)::bigint deposits,
               coalesce(sum(delta) filter (where reason = 'adjustment'), 0)::bigint adjustments,
               (select coalesce(sum(stack), 0) from seats)::bigint on_tables,
               (select coalesce(sum(chips), 0) from users)::bigint in_accounts
        from ledger_entries`;
      const inFlight = Number(flow.on_tables);
      const imbalance = Number(flow.buy_ins) + Number(flow.cash_outs) + inFlight;
      checks.push({
        name: 'chips conserve across tables',
        meaning: 'buy-ins and cash-outs do not cancel once live stacks are counted; chips were minted or lost',
        rows: imbalance === 0 ? [] : [{ buyIns: flow.buy_ins, cashOuts: flow.cash_outs, onTables: inFlight, imbalance }],
      });

      // Everything that is not a chip moving onto or off a table enters or
      // leaves the system. Each reason is named, so one added later fails this
      // check until somebody decides which side of the books it belongs on.
      const expected = Number(flow.grants) + Number(flow.deposits) + Number(flow.adjustments) + Number(flow.fees);
      checks.push({
        name: 'every chip came from a grant, a deposit or an adjustment',
        meaning: 'accounts plus live stacks do not equal what entered the system less entry fees',
        rows:
          Number(flow.in_accounts) + inFlight === expected
            ? []
            : [{ inAccounts: flow.in_accounts, onTables: inFlight, expected }],
      });

      summary = {
        grants: flow.grants,
        deposits: flow.deposits,
        adjustments: flow.adjustments,
        entryFees: flow.fees,
        inAccounts: flow.in_accounts,
        onTables: inFlight,
      };
    });
  } finally {
    await sql.end();
  }

  let failed = 0;
  for (const check of checks) {
    if (check.rows.length === 0) {
      console.log(`ok    ${check.name}`);
      continue;
    }
    failed += 1;
    console.log(`FAIL  ${check.name}: ${check.meaning}`);
    for (const row of check.rows) console.log(`      ${JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  }
  console.log(JSON.stringify(summary, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
