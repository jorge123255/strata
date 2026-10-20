/** Embedded bot views must never fall back to an unrelated conversation. */
export function selectedChat<T extends { id: string }>(sessions: T[], wanted: string | null | undefined, embedded = false): T | null {
  const exact = sessions.find(session => session.id === wanted);
  return exact ?? (embedded ? null : sessions[0] ?? null);
}
