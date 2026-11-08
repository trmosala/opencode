import type { CdpNetworkSummary } from "./capture-verdict"

const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_STALL_MS = 2_000
const DEFAULT_POLL_MS = 250

export function shouldAwaitCdpFinish(result: unknown, witness: CdpNetworkSummary): boolean {
  if (!witness.cdpRequestSeen || witness.cdpFinished || witness.cdpFailed) return false
  if (!result || typeof result !== "object") return true
  return Reflect.get(result, "responseSource") !== "network"
}

// Poll the CDP witness after content.js returned non-network / no-response while a model request
// is still in flight. Avoids instant unfinished-stream 502s when the page recorder timed out a
// beat before Network.loadingFinished. Bytes stall (~2s without growth) exits early so a hung
// stream does not burn the full timeout.
export async function awaitCdpWitnessSettle(
  summarize: () => CdpNetworkSummary,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    stallMs = DEFAULT_STALL_MS,
    pollMs = DEFAULT_POLL_MS,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    timeoutMs?: number
    stallMs?: number
    pollMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<CdpNetworkSummary> {
  const startedAt = now()
  let lastBytes = -1
  let lastBytesAt = startedAt

  for (;;) {
    const witness = summarize()
    if (witness.cdpFinished || witness.cdpFailed) return witness

    const t = now()
    if (witness.cdpBytes !== lastBytes) {
      lastBytes = witness.cdpBytes
      lastBytesAt = t
    }
    if (t - startedAt >= timeoutMs) return witness
    if (t - lastBytesAt >= stallMs) return witness

    await sleep(pollMs)
  }
}
