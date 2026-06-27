export function renderStatusPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>O1-Code Bridge</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  :root {
    color-scheme: light dark;
    --bg: #0d1117; --fg: #c9d1d9; --muted: #8b949e; --card: #161b22; --border: #30363d;
    --green: #3fb950; --red: #f85149; --yellow: #d29922; --accent: #58a6ff;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #f6f8fa; --fg: #1f2328; --muted: #57606a; --card: #fff; --border: #d0d7de;
            --green: #1a7f37; --red: #cf222e; --yellow: #9a6700; --accent: #0969da; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         background: var(--bg); color: var(--fg); padding: 32px; max-width: 720px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 16px; }
  .row { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .ok { background: var(--green); }
  .warn { background: var(--yellow); }
  .err { background: var(--red); }
  .label { color: var(--muted); width: 140px; flex-shrink: 0; }
  .val { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .banner { display: none; border-color: var(--red); }
  .banner.show { display: block; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  button { background: transparent; color: var(--accent); border: 1px solid var(--border);
           border-radius: 6px; padding: 6px 12px; font: inherit; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  .footer { color: var(--muted); font-size: 12px; margin-top: 24px; }
  code { background: rgba(110,118,129,0.2); padding: 1px 6px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<h1>O1-Code Bridge</h1>
<div class="sub">OpenAI-compatible proxy for O1-Code. <span id="updated"></span></div>

<div class="card banner" id="authBanner">
  <div class="row"><div class="dot err"></div><div class="label">WPP login</div><div class="val" id="authVal">required</div></div>
  <div class="row"><button onclick="openLogin()">Sign in to WPP</button></div>
</div>

<div class="card">
  <div class="row"><div id="proxyDot" class="dot warn"></div><div class="label">Proxy</div><div class="val" id="proxyVal">checking…</div></div>
  <div class="row"><div id="bridgeDot" class="dot warn"></div><div class="label">Worker bridge</div><div class="val" id="bridgeVal">checking…</div></div>
  <div class="row"><div class="label">Pending jobs</div><div class="val" id="pendingVal">—</div></div>
  <div class="row"><div class="label">In-flight</div><div class="val" id="inflightVal">—</div></div>
  <div class="row"><div class="label">Active job</div><div class="val" id="jobVal">—</div></div>
  <div class="row"><div class="label">Last legacy poll</div><div class="val" id="clientVal">—</div></div>
  <div class="row"><div class="label">Bridge counters</div><div class="val" id="bridgeCountersVal">—</div></div>
  <div class="row"><div class="label">Executor phase</div><div class="val" id="executorPhaseVal">—</div></div>
  <div class="row"><div class="label">Executor counters</div><div class="val" id="executorCountersVal">—</div></div>
  <div class="row"><div class="label">Recent job</div><div class="val" id="recentJobVal">—</div></div>
</div>

<div class="card">
  <div class="row">
    <button onclick="window.open('https://ogilvy.os.wpp.com/agent/workspace','_blank')">Open O1-Code workspace</button>
    <button onclick="refresh()">Refresh</button>
  </div>
</div>

<div class="footer">
  Auto-refreshes every 3s. API base: <code>http://127.0.0.1:8787/v1</code>
</div>

<script>
async function refresh() {
  document.getElementById('updated').textContent = '';
  try {
    const [healthRes, bridgeRes] = await Promise.all([
      fetch('/health').then(r => r.ok ? r.json() : Promise.reject(new Error('health failed'))),
      fetch('/bridge/health').then(r => r.json())
    ]);
    setDot('proxyDot', 'ok'); setText('proxyVal', 'listening on 127.0.0.1:8787');
    const auth = bridgeRes.auth || {};
    document.getElementById('authBanner').className = 'card banner' + (auth.required ? ' show' : '');
    setText('authVal', auth.reason || 'required');
    const lastSeen = bridgeRes.clients && bridgeRes.clients[0]
      ? new Date(bridgeRes.clients[0].lastSeenAt)
      : null;
    const inFlight = (bridgeRes.inFlightJobs ?? 0) > 0;
    const recent = inFlight || (lastSeen && (Date.now() - lastSeen.getTime() < 15000));
    setDot('bridgeDot', auth.required ? 'err' : (recent || bridgeRes.recentJobs?.length ? 'ok' : 'warn'));
    setText('bridgeVal', inFlight
      ? 'running worker job'
      : (auth.required ? 'WPP login required' : (bridgeRes.recentJobs?.length ? 'ready' : 'no worker jobs yet')));
    setText('pendingVal', String(bridgeRes.pendingJobs ?? 0));
    setText('inflightVal', String(bridgeRes.inFlightJobs ?? 0));
    setText('jobVal', formatJob(bridgeRes.jobs && bridgeRes.jobs[0]));
    const client = bridgeRes.clients && bridgeRes.clients[0] ? bridgeRes.clients[0] : null;
    setText('clientVal', lastSeen ? lastSeen.toLocaleTimeString() : '—');
    setText('bridgeCountersVal', formatBridgeCounters(bridgeRes.counters));
    setText('executorPhaseVal', client ? (client.phase || 'unknown') : '—');
    setText('executorCountersVal', formatExecutorCounters(client && client.counters));
    setText('recentJobVal', formatJob(bridgeRes.recentJobs && bridgeRes.recentJobs[0]));
  } catch (err) {
    setDot('proxyDot', 'err'); setText('proxyVal', 'unreachable: ' + err.message);
    setDot('bridgeDot', 'err'); setText('bridgeVal', 'unknown');
  }
  document.getElementById('updated').textContent = '— updated ' + new Date().toLocaleTimeString();
}
async function openLogin() {
  await fetch('/bridge/login', { method: 'POST' }).catch(() => null);
}
function setDot(id, state) {
  const el = document.getElementById(id);
  el.className = 'dot ' + state;
}
function setText(id, text) {
  document.getElementById(id).textContent = text;
}
function ago(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}
function formatBridgeCounters(counters = {}) {
  return [
    'enqueued ' + (Number(counters.enqueued) || 0),
    'leased ' + (Number(counters.leased) || 0),
    'succeeded ' + (Number(counters.succeeded) || 0),
    'failed ' + (Number(counters.failed) || 0),
    'expired ' + (Number(counters.expired) || 0)
  ].join(' · ');
}
function formatExecutorCounters(counters = {}) {
  if (!counters) return '—';
  return [
    (Number(counters.polls) || 0) + ' polls',
    (Number(counters.skippedPolls) || 0) + ' skipped',
    (Number(counters.frameScans) || 0) + ' scans',
    (Number(counters.injections) || 0) + ' injections',
    (Number(counters.recorderArmFailures) || 0) + ' recorder failures',
    (Number(counters.resultBytes) || 0) + ' result bytes',
    (Number(counters.avgPollMs) || 0) + 'ms avg poll',
    (Number(counters.avgJobMs) || 0) + 'ms avg job'
  ].join(' · ');
}
function formatJob(job) {
  if (!job) return '—';
  return job.state + ' · age ' + Math.round((job.ageMs || 0) / 1000) + 's · timeout in ' + Math.round((job.expiresInMs || 0) / 1000) + 's';
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
}
