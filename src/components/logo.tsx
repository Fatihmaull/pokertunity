/*
  The brand in one place. It was a private `Suit()` inside the header, which
  left the footer and the tab icon with no way to reach it.

  The source artwork is one JPEG of the full lockup on black. JPEG carries no
  alpha channel, so that black is part of the file and cannot be cut out of it.
  Two consequences, both load-bearing:

    - Mark and wordmark are not separate files, so each is a background-image
      cropped to its own region of the one image. The numbers are measured from
      the artwork, not guessed; re-measure them if the file is ever re-exported.
    - `mix-blend-lighten` is what removes the black. Lighten keeps the
      per-channel maximum, so #000 resolves to whatever sits behind it while the
      white and the red come through untouched -- which is what hands the two
      face profiles back their transparency. It holds only because every surface
      behind the mark is darker than the artwork. A light background would wash
      it out.

  Re-exporting the logo as an SVG with the faces as real holes would let this
  whole file collapse back into a plain <img>.
*/

const ART = 'url(/brand/logo-icon.jpeg)';

/**
 * The shield alone, cropped from x 424..830, y 345..748 of the 1254px square.
 * Sized in `em` so it tracks whatever text it is set beside.
 */
export function LogoMark({ className = 'h-[1.6em] w-[1.6em]' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`${className} block shrink-0 bg-no-repeat mix-blend-lighten`}
      style={{
        backgroundImage: ART,
        backgroundSize: '308.11% 310.40%',
        backgroundPosition: '50.06% 40.59%',
      }}
    />
  );
}

/**
 * Mark over wordmark, cropped from x 206..1050, y 345..885.
 *
 * This is the only place the drawn wordmark appears -- the spade standing in
 * for the O is too fine to survive the header, and setting it in Archivo beside
 * the mark would put two different letterforms of the same word on one screen.
 */
export function LogoLockup({ className = 'h-9' }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Pokertunity"
      className={`${className} block aspect-[845/541] bg-no-repeat mix-blend-lighten`}
      style={{
        backgroundImage: ART,
        backgroundSize: '148.40% 231.79%',
        backgroundPosition: '50.37% 48.39%',
      }}
    />
  );
}
