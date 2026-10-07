import { randomUUID } from "node:crypto"

// Saved sessions can be opened by multiple backends. WPP thread ownership is process-local.
export const RequestIdentity = { id: randomUUID() }
