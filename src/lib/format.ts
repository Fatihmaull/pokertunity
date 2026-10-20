/** What a match is called on screen. */
export function matchLabel(number: number): string {
  return `Match ${number}`;
}

/**
 * A change, signed the way a reader expects: a plus above zero, a true minus
 * below it, and a bare zero, which is even.
 *
 * Rounded before the sign is chosen, so a value that displays as zero shows as
 * a bare "0". The minus is U+2212, the width of the plus, so a column of figures lines up on its signs.
 */
export function formatSigned(value: number, digits = 0): string {
  const rounded = Number(value.toFixed(digits));
  const body = Math.abs(rounded).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (rounded > 0) return `+${body}`;
  if (rounded < 0) return `−${body}`;
  return body;
}
