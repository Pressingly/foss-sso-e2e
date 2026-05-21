// Penpot RPC responses (e.g. `/api/rpc/command/get-profile`) come back
// as Transit-JSON: a flat array starting with the `"^ "` marker followed
// by alternating keys (`~:email`, `~:fullname`, etc.) and values. Used
// by both `identity-consistency.spec.ts` and `header-spoofing.spec.ts`;
// kept in one place so any shape drift (e.g. Penpot wrapping the
// response in `{"~:result": [...]}`) is fixed once.

export function extractPenpotTransitField(
  body: unknown,
  key: `~:${string}`
): string {
  if (!Array.isArray(body)) {
    throw new Error(
      `Penpot RPC response is not a Transit array; got ${typeof body}`
    );
  }
  if (body[0] !== "^ ") {
    throw new Error(
      `Penpot RPC response missing Transit map marker "^ "; got first elem ${JSON.stringify(body[0])}`
    );
  }
  // After the `"^ "` marker the array alternates key, value, key, value:
  // keys live at odd indices (1, 3, 5, …), values at even indices
  // (2, 4, 6, …). Scan ONLY key positions — a naive `indexOf` would
  // match a value that happens to be the literal string `"~:email"`
  // (e.g. a fullname field set to that string), returning the wrong
  // field. Not a realistic case for real Penpot data, but the guard
  // is essentially free.
  for (let i = 1; i < body.length; i += 2) {
    if (body[i] === key) {
      if (i + 1 >= body.length) {
        throw new Error(
          `Penpot RPC response has key ${key} at position ${i} but no value follows`
        );
      }
      return String(body[i + 1]);
    }
  }
  throw new Error(
    `Penpot RPC response missing key ${key}: ${JSON.stringify(body).slice(0, 200)}`
  );
}
