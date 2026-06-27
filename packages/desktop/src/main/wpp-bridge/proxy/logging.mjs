import { mkdir, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "./policy.mjs";

const DEFAULT_LOG_KEEP = 200;
// Only generated run-JSON files (ISO-timestamp prefix). Anything else in the dir — and the
// root debug log, which lives outside logDir — is never touched by pruning.
const RUN_LOG_PATTERN = /^\d{4}-\d{2}-\d{2}T.*\.json$/u;

export async function writeRunLog(record) {
  if (process.env.O1_CODE_PROXY_LOGS === "0") {
    return null;
  }

  const logDir = process.env.O1_CODE_PROXY_LOG_DIR || join(process.cwd(), "logs");
  const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${record.id || "run"}.json`;
  const path = join(logDir, fileName);

  await mkdir(logDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(redact(record), null, 2)}\n`, "utf8");
  await pruneRunLogs(logDir).catch(() => {});

  return path;
}

function logKeep() {
  const configured = Number(process.env.O1_CODE_PROXY_LOG_KEEP);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LOG_KEEP;
}

// Best-effort retention: keep the most recent N generated run-JSON files, delete older ones.
// The ISO-timestamp filename prefix sorts chronologically, so a lexical sort is enough.
async function pruneRunLogs(logDir) {
  const keep = logKeep();
  const entries = (await readdir(logDir)).filter((name) => RUN_LOG_PATTERN.test(name));

  if (entries.length <= keep) {
    return;
  }

  entries.sort();
  const stale = entries.slice(0, entries.length - keep);

  await Promise.all(stale.map((name) => unlink(join(logDir, name)).catch(() => {})));
}
