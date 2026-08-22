/**
 * Structured logging: one JSON line per event, collected by Workers observability.
 *
 * Allowed fields: method, path, tool name, outcome, HTTP status, durations, a request id.
 * NEVER a header value, a token, a handle's disclosed fields or any upstream body.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function log(event: string, fields: LogFields): void {
  console.log(JSON.stringify({ event, ...fields }));
}
