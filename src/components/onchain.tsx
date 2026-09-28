'use client';

import { txUrl, type PublicChain } from '@/lib/chains';
import { MIN_ATTESTED_HANDS, type OnChainRecord } from '@/lib/erc8004';
import { useChain } from './chain-context';
import { Badge } from './ui';

/**
 * Where an agent's ERC-8004 record can be checked without taking our word.
 *
 * Every figure here links out to the chain or to the exact evidence document
 * its hash covers, because a rating the arena merely displays is a claim, and
 * the point of publishing it is that nobody has to trust the arena for it.
 */

function External({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent underline-offset-4 hover:underline">
      {children}
    </a>
  );
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The line under an agent's name in the standings, for the chain being viewed.
 *
 * Only that chain, so a visitor who arrived through one network's link sees
 * proof from that network and not a list of explorers they did not ask about.
 */
export function OnChainTag({ records }: { records: OnChainRecord[] }) {
  const { chain } = useChain();
  const record = chain ? records.find((entry) => entry.chain === chain.key) : undefined;
  if (!chain || !record) return null;

  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <a href={txUrl(chain, record.mintTx)} target="_blank" rel="noreferrer" title={`Identity minted on ${chain.name}`}>
        <Badge tone="accent">ERC-8004 #{record.registryId}</Badge>
      </a>
      {record.published ? (
        <span className="text-faint">
          <External href={txUrl(chain, record.published.tx)}>{record.published.rating.toFixed(1)} on chain</External>
          {' · '}
          <External href={`/api/attestations/${record.published.attestationId}`}>evidence</External>
        </span>
      ) : null}
    </span>
  );
}

/** The owner's view: every chain, including the ones not reached yet. */
export function OnChainPanel({
  agentId,
  records,
  hands,
}: {
  agentId: string;
  records: OnChainRecord[];
  hands: number;
}) {
  const { chains, chain: active } = useChain();

  return (
    <section className="mt-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="label text-faint">ERC-8004</h3>
        {records.length > 0 ? (
          <span className="text-xs">
            <External href={`/api/agents/${agentId}/registration`}>Registration file</External>
          </span>
        ) : null}
      </div>

      {records.length === 0 ? (
        <p className="mt-2 text-xs text-faint">
          {hands < MIN_ATTESTED_HANDS
            ? `Not on chain yet. ${MIN_ATTESTED_HANDS - hands} more hands to go.`
            : 'Eligible. Published with the next batch.'}
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {chains.map((chain) => (
            <ChainRow
              key={chain.key}
              chain={chain}
              active={chain.key === active?.key}
              record={records.find((entry) => entry.chain === chain.key)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ChainRow({ chain, active, record }: { chain: PublicChain; active: boolean; record?: OnChainRecord }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
      <span className={`w-32 shrink-0 ${active ? 'font-semibold text-ink' : 'text-muted'}`}>{chain.shortName}</span>
      {record ? (
        <>
          <External href={txUrl(chain, record.mintTx)}>Identity #{record.registryId}</External>
          {record.published ? (
            <span className="mono text-muted tabular-nums">
              {record.published.rating.toFixed(1)} rating · {record.published.confidence}/100 confidence ·{' '}
              <External href={txUrl(chain, record.published.tx)}>{when(record.published.at)}</External>
              {' · '}
              <External href={`/api/attestations/${record.published.attestationId}`}>evidence</External>
            </span>
          ) : (
            <span className="text-faint">registered, no record yet</span>
          )}
        </>
      ) : (
        <span className="text-faint">not registered here yet</span>
      )}
    </li>
  );
}
