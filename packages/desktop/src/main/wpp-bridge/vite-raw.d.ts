// The injected scripts (pageRecorder.js / content.js) are not part of any process bundle —
// they execute inside the WPP webview's page context. We import their source as a raw string
// (Vite ?raw) so the main-process build embeds them and we inject via CDP at runtime.
declare module "*?raw" {
  const content: string
  export default content
}
