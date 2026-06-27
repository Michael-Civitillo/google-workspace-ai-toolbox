/**
 * Shared request-body reader with a hard size cap.
 *
 * Every mutating API route needs the same guard: don't let a caller stream an
 * unbounded payload into memory (and, for some routes, into the audit log).
 * This module is the single implementation of that guard so the cap can't drift
 * between routes.
 *
 * Two things the per-route copies it replaces got wrong:
 *   1. They called `request.text()`, which buffers the ENTIRE body into memory
 *      before any length check runs — so a chunked request that omits
 *      Content-Length defeated the cap. Here we read the stream incrementally
 *      and abort the moment the running byte count exceeds the limit.
 *   2. They compared `raw.length` (UTF-16 code units) against a byte limit, so a
 *      multibyte body could slip past or trip early. Here the cap is enforced on
 *      real bytes off the wire.
 */

/** Returned in place of the body when it exceeds the byte cap. */
export const BODY_TOO_LARGE = Symbol("BODY_TOO_LARGE");
export type BodyTooLarge = typeof BODY_TOO_LARGE;

/**
 * Read a request body as text under a hard byte cap (measured in real UTF-8
 * bytes, not UTF-16 code units). Streams the body and aborts as soon as the cap
 * is exceeded, so an oversized payload — including a chunked request that omits
 * Content-Length — is never fully buffered first. A body that can't be read
 * (client abort / stream error) resolves to an empty string, matching the
 * previous `try { await request.text() } catch {}` behavior.
 *
 * Returns {@link BODY_TOO_LARGE} when the body exceeds `maxBytes`; the caller
 * maps that to a 413 in whatever response shape it uses.
 */
export async function readCappedBody(
  request: Request,
  maxBytes: number
): Promise<string | BodyTooLarge> {
  // Cheap early reject when the client declares an oversized length. A chunked
  // request can omit or understate this, so it's only a fast path — the real
  // guard is the streamed byte count below.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return BODY_TOO_LARGE;

  const stream = request.body;
  if (!stream) {
    try {
      const raw = await request.text();
      return new TextEncoder().encode(raw).length > maxBytes
        ? BODY_TOO_LARGE
        : raw;
    } catch {
      return "";
    }
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) return BODY_TOO_LARGE;
      chunks.push(value);
    }
  } catch {
    return "";
  } finally {
    // Discard anything unread (the too-large path) and release the lock. On the
    // normal path the stream is already closed, so this is a no-op.
    reader.cancel().catch(() => {});
  }

  if (total === 0) return "";
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

/**
 * Read a request body as JSON under a hard byte cap. Malformed JSON resolves to
 * `{}` — callers validate individual fields and reject downstream — preserving
 * the routes' previous swallow-and-continue behavior. Returns
 * {@link BODY_TOO_LARGE} when the body exceeds `maxBytes`.
 */
export async function readCappedJson(
  request: Request,
  maxBytes: number
): Promise<Record<string, unknown> | BodyTooLarge> {
  const raw = await readCappedBody(request, maxBytes);
  if (raw === BODY_TOO_LARGE) return BODY_TOO_LARGE;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
