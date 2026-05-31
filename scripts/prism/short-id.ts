// 6-char base62 share tokens. YouTube-style — random, immutable once
// minted, written back into the entry JSON so they survive renames and
// re-annotations.

const ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export const SHORT_ID_LENGTH = 6;

/** Mint a fresh, collision-free 6-char id. Caller passes the set of
 *  already-claimed ids; the mint loops until it finds one that isn't
 *  in the set. 62^6 = ~56B combinations vs. our ~644 entries, so
 *  collisions are astronomically rare — the cap is a safety net. */
export function mintShortId(taken: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    let id = "";
    for (let j = 0; j < SHORT_ID_LENGTH; j++) {
      id += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    if (!taken.has(id)) return id;
  }
  throw new Error(`short-id mint: 100 collisions in a row — RNG broken?`);
}
