'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';

/**
 * The shared control vocabulary. Every button, card and badge in the product
 * comes from here, so a control that looks the same behaves the same and
 * nothing has to be restyled twice.
 */

type ButtonTone = 'primary' | 'secondary' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

const TONES: Record<ButtonTone, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover disabled:hover:bg-accent',
  secondary: 'border border-line-strong bg-surface-2 text-ink hover:bg-surface-3 hover:border-line-strong',
  ghost: 'text-muted hover:bg-surface-2 hover:text-ink',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3 text-[0.8125rem]',
  md: 'h-9 gap-2 px-4 text-sm',
  lg: 'h-11 gap-2 px-5 text-[0.9375rem]',
};

/*
  A control gives under a press. It is 3% and 120ms and nobody will ever name
  it, which is the point: a button that does not move under the pointer is the
  difference between a page that responds and a page that merely re-renders.
*/
const BUTTON_BASE =
  'inline-flex shrink-0 items-center justify-center rounded-control font-medium whitespace-nowrap transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100';

export function Button({
  tone = 'secondary',
  size = 'md',
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone; size?: ButtonSize }) {
  return <button type="button" className={`${BUTTON_BASE} ${TONES[tone]} ${SIZES[size]} ${className}`} {...rest} />;
}

export function ButtonLink({
  href,
  tone = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}: React.ComponentProps<typeof Link> & { tone?: ButtonTone; size?: ButtonSize }) {
  return (
    <Link href={href} className={`${BUTTON_BASE} ${TONES[tone]} ${SIZES[size]} ${className}`} {...rest}>
      {children}
    </Link>
  );
}

export function Card({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return <div className={`rounded-card border border-line bg-surface ${className}`}>{children}</div>;
}

type BadgeTone = 'neutral' | 'accent' | 'live' | 'warning' | 'danger';

/*
  `live` and `danger` are both red because red carries one meaning here: look
  at this. They are separate tones anyway, because a table that is dealing and
  a deposit that failed are not the same event, and the day one of them needs
  to stop being red the other should not move with it.
*/
const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'border-line-strong bg-surface-2 text-muted',
  accent: 'border-accent/35 bg-accent-soft text-accent',
  live: 'border-brand/40 bg-danger-soft text-danger',
  warning: 'border-warning/35 bg-warning/10 text-warning',
  danger: 'border-danger/35 bg-danger-soft text-danger',
};

export function Badge({
  tone = 'neutral',
  className = '',
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE_TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** A table that is dealing right now. The dot is the convention people know. */
export function LiveBadge({ label = 'Live' }: { label?: string }) {
  return (
    <Badge tone="live">
      <span className="live-dot h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
      {label}
    </Badge>
  );
}

export function Stat({
  label,
  value,
  hint,
  title,
  className = '',
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  /** The longer explanation, for whoever hovers. */
  title?: string;
  className?: string;
}) {
  return (
    <div className={className} title={title}>
      <dt className="label text-faint">{label}</dt>
      <dd className="mono mt-1 text-lg text-ink tabular-nums">{value}</dd>
      {hint ? <p className="mt-0.5 text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

/**
 * An empty screen is an invitation to act, so it always carries the action that
 * fills it rather than only reporting that there is nothing here.
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <h3 className="text-base text-ink">{title}</h3>
      {body ? <p className="max-w-[42ch] text-sm text-muted">{body}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/**
 * Closes an open menu on a click outside it or on Escape.
 *
 * A menu that stays open after you have clicked elsewhere is a menu you have to
 * dismiss twice, so the document closes it and Escape does too. The ref it
 * returns marks what counts as inside.
 */
export function useDismissed(
  open: boolean,
  setOpen: (open: boolean) => void,
): RefObject<HTMLDivElement | null> {
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  return wrapper;
}

/**
 * Detail that only some readers want, closed until asked for.
 *
 * The contents mount when it opens rather than being hidden, so a closed one
 * fetches nothing. That matters where the detail is an expensive read made
 * once per agent on the page.
 */
export function Disclosure({
  summary,
  defaultOpen = false,
  className = '',
  children,
}: {
  summary: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 text-left text-sm font-medium text-muted transition-colors hover:text-ink"
      >
        {summary}
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className={`h-4 w-4 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        >
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open ? (
        <div id={id} className="mt-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The top of every page reached from the navigation, so each one opens on the
 * same left edge with the same title treatment and a visitor moving between
 * them sees the content change rather than the frame.
 */
export function PageHeader({
  title,
  badges,
  sub,
  action,
  back,
}: {
  title: React.ReactNode;
  /** State of the thing titled, set on the title's line. */
  badges?: React.ReactNode;
  sub?: React.ReactNode;
  action?: React.ReactNode;
  back?: React.ReactNode;
}) {
  return (
    <header className="mb-6">
      {back}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="display text-[2rem] text-ink sm:text-[2.5rem]">{title}</h1>
            {badges}
          </div>
          {sub ? <p className="mt-2 max-w-[62ch] text-sm text-muted">{sub}</p> : null}
        </div>
        {action}
      </div>
    </header>
  );
}

/**
 * The way back up, for a page somebody can land on cold from a shared link.
 * One step, named after where it goes, because the title below it already says
 * where they are.
 */
export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="mb-3 inline-flex items-center gap-1.5 text-sm text-faint transition-colors hover:text-ink"
    >
      <span aria-hidden>←</span>
      {children}
    </Link>
  );
}

/** A link that leaves the arena, to an explorer, a document or the repository, in a tab of its own. */
export function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent underline-offset-4 hover:underline">
      {children}
    </a>
  );
}

export function SectionHeading({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <div>
        <h2 className="text-xl text-ink">{title}</h2>
        {sub ? <p className="mt-1 text-sm text-muted">{sub}</p> : null}
      </div>
      {action}
    </div>
  );
}
