// Starts each given app for real and waits for its web UI to answer.
// Run: node scripts/smoke.mjs <appId> [appId ...]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

const root = path.resolve(import.meta.dirname, "..");
const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("usage: node scripts/smoke.mjs <appId> [appId ...]");
  process.exit(2);
}

const docker = (args, options = {}) => execFileSync("docker", args, { stdio: "pipe", ...options });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Any answer counts: code-server redirects to a login page, others may 401.
      await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      return true;
    } catch {
      await sleep(3000);
    }
  }
  return false;
}

let failed = 0;
for (const [index, id] of ids.entries()) {
  const meta = yaml.load(readFileSync(path.join(root, "Apps", id, "homeio.yml"), "utf8"));
  const tmp = mkdtempSync(path.join(os.tmpdir(), `homeio-store-${id}-`));
  const hostPort = 29000 + index;
  const project = `homeio-smoke-${id}`;

  // Bind mounts go to a temp folder and the web port moves out of the way, so
  // the test cannot collide with anything already running on this machine.
  const compose = readFileSync(path.join(root, "Apps", id, "docker-compose.yml"), "utf8")
    .replaceAll("/DATA/AppData", tmp)
    .replace(/published: "\d+"/, `published: "${hostPort}"`)
    .replace(/^\s*container_name: .*\n/m, "");
  const composePath = path.join(tmp, "docker-compose.yml");
  writeFileSync(composePath, compose);
  const env = { ...process.env, AppID: id };

  try {
    console.log(`${id}: pulling and starting`);
    docker(["compose", "-p", project, "-f", composePath, "up", "-d", "--pull", "missing"], { env });
    const url = `http://localhost:${hostPort}${meta.index ?? "/"}`;
    const ok = await waitForHttp(url, 180_000);
    console.log(`${id}: ${ok ? "ok" : "FAILED"} (${url})`);
    if (!ok) {
      failed += 1;
      console.error(docker(["compose", "-p", project, "-f", composePath, "logs", "--tail", "30"], { env }).toString());
    }
  } catch (error) {
    failed += 1;
    console.error(`${id}: FAILED ${String(error.stderr ?? error.message)}`);
  } finally {
    try { docker(["compose", "-p", project, "-f", composePath, "down", "-v"], { env }); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
