/** A call that rings here: one to answer or decline (an outbound call rings at the other end). */
export const isIncoming = call => call.direction === 'inbound' && call.state === 'ringing'

/** The call to show: one that rings here first, else one under way; with the window that has it. */
export const callToShow = windows => {
  const all = [...windows.entries()].flatMap(([window, calls]) => calls.map(call => ({ ...call, window })))
  // ponytail: one card; a second call ringing at once waits for the first to be answered or declined.
  return all.find(isIncoming) ?? all[0] ?? null
}
