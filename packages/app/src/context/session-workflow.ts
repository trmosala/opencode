export type SessionWorkflow = {
  state: "snoozed" | "settled"
  updated: number
  // Latest observed user-message time, in the backend clock domain.
  prompt?: number
  at?: number
  until?: number
  // Persisted by earlier builds; finish existing requests but do not create new ones from the sidebar.
  pending?: boolean
}

export type SessionActivity = {
  working: boolean
  attention: boolean
  prompt: number
}

export function sessionWorkflowState(entry: SessionWorkflow | undefined, now: number, activity: SessionActivity) {
  const active = activity.working && !activity.attention ? "working" : "inbox"
  if (!entry || entry.pending || activity.attention || activity.prompt > (entry.prompt ?? entry.updated)) return active
  if (entry.state === "snoozed") return (entry.until ?? 0) > now ? "snoozed" : active
  return "settled"
}
