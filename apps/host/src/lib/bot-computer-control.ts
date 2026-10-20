/** The server serializes input and release for a target. Release only after
 * this viewer's outstanding input has settled, including when it failed. */
export async function releaseAfterComputerAction(pending: Promise<unknown> | null, release: () => Promise<unknown>) {
  if (pending) await pending.catch(() => {});
  await release();
}

/** Returning to the tab cannot revive a grant requested before it was hidden. */
export function acceptsComputerResponse(requestGeneration: number, currentGeneration: number, mounted: boolean, visible: boolean) {
  return mounted && visible && requestGeneration === currentGeneration;
}
