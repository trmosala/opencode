export function shouldIgnoreListenError(error) {
  return error?.code === "EADDRINUSE";
}
