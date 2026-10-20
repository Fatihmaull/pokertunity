'use client';

import { useEffect, useState } from 'react';

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
}

export interface Lobby {
  matches: LobbyMatch[];
  /** Matches this account has an agent in. One owner holds at most one seat in each. */
  mine: string[];
  /** Which page of the ended matches this is, and how many there are. */
  page: number;
  pages: number;
  /** False until the first poll lands and the floor is known. */
  loaded: boolean;
  /** The last poll was refused or timed out. */
  failed: boolean;
}

/**
 * What is being dealt right now, and one page of what has ended.
 *
 * Matches are created by the matchmaker and settled the moment they end, so
 * the server is where the list comes from, and it starts empty until the first
 * poll lands.
 */
export function useLobby(page = 1): Lobby {
  const [matches, setMatches] = useState<LobbyMatch[]>([]);
  const [mine, setMine] = useState<string[]>([]);
  const [paging, setPaging] = useState({ page: 1, pages: 1 });
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  // The floor is external state, so it is polled and applied in a callback
  // after the effect body runs.
  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      // A refusal differs from an empty floor. Keeping what is on screen until
      // the next poll is honest. It is still recorded, because before the first
      // answer the screen is empty, and the failure message replaces "loading".
      fetch(`/api/matches?page=${page}`, { cache: 'no-store' })
        .then((response) =>
          response.ok
            ? (response.json() as Promise<{ matches: LobbyMatch[]; mine: string[]; page: number; pages: number }>)
            : null,
        )
        .then((body) => {
          if (cancelled) return;
          if (!body) {
            setFailed(true);
            return;
          }
          setMatches(body.matches);
          setMine(body.mine);
          setPaging({ page: body.page, pages: body.pages });
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
  }, [page]);

  return { matches, mine, page: paging.page, pages: paging.pages, loaded, failed };
}
