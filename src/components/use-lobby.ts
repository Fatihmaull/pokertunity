'use client';

import { useCallback, useEffect, useState } from 'react';

export interface LobbySeat {
  index: number;
  name: string | null;
  color: string | null;
  stack: number;
  /** Out of chips. Still shown, because where it finished is part of the record. */
  busted: boolean;
  isMine: boolean;
}

export interface LobbyMatch {
  id: string;
  label: string;
  status: string;
  seatCount: number;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  handCap: number;
  handNumber: number;
  live: boolean;
  pot: number;
  /** Average rating of the entrants, which is the band this match was drawn from. */
  bandRating: number | null;
  startedAt: string | null;
  endedAt: string | null;
  seats: LobbySeat[];
}

export interface Lobby {
  matches: LobbyMatch[];
  /** Matches this account has an agent in. One owner holds at most one seat in each. */
  mine: string[];
  /** Whether any of this account's agents is connected and asking for a game. */
  queued: boolean;
  /** False until the first poll lands, when nothing about the floor is known. */
  loaded: boolean;
  /** The last poll was refused or never answered. */
  failed: boolean;
  reload: () => void;
}

/**
 * What is being dealt right now.
 *
 * There is no roster. Matches are created by the matchmaker and settled the
 * moment they end, so which ones exist is only knowable from the server and the
 * list starts empty until the first poll lands.
 */
export function useLobby(): Lobby {
  const [matches, setMatches] = useState<LobbyMatch[]>([]);
  const [mine, setMine] = useState<string[]>([]);
  const [queued, setQueued] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reloads, setReloads] = useState(0);

  const reload = useCallback(() => setReloads((count) => count + 1), []);

  // The floor is external state, so it is polled and applied in a callback
  // rather than assigned while the effect body runs.
  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      // A refusal is not an empty floor. Keeping what is on screen until the
      // next poll is honest; replacing it with the error body is not. It is
      // still recorded, because before the first answer there is nothing on
      // screen to keep, and "loading" would otherwise be shown forever.
      fetch('/api/matches', { cache: 'no-store' })
        .then((response) =>
          response.ok ? (response.json() as Promise<{ matches: LobbyMatch[]; mine: string[]; queued: boolean }>) : null,
        )
        .then((body) => {
          if (cancelled) return;
          if (!body) {
            setFailed(true);
            return;
          }
          setMatches(body.matches);
          setMine(body.mine);
          setQueued(body.queued);
          setLoaded(true);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };

    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [reloads]);

  return { matches, mine, queued, loaded, failed, reload };
}

export function seatsTaken(match: LobbyMatch): number {
  return match.seats.filter((seat) => seat.name).length;
}
