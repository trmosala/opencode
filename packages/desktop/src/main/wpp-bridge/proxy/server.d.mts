// Ambient declaration for the dep-free proxy entrypoint copied verbatim from the
// silent-moon repo. The implementation (server.mjs) is plain Node ESM with no types;
// this keeps `tsgo -b` typecheck green when the Electron main process imports it.
export function startServer(options?: {
  host?: string
  port?: number
  openLogin?: () => void | Promise<void>
}): Promise<void>
