// Starts each given app for real and waits for its web UI to answer.
// Run: node scripts/smoke.mjs [--keep] <appId> [appId ...]
// --keep leaves the apps running, to take screenshots; `--down` stops whatever --keep left.
import { execFileSync } from "node:child_process";
import net from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

const root = path.resolve(import.meta.dirname, "..");
const keep = process.argv.includes("--keep");

if (process.argv.includes("--down")) {
  const projects = JSON.parse(execFileSync("docker", ["compose", "ls", "--all", "--format", "json"]).toString());
  for (const { Name } of projects.filter(({ Name }) => Name.startsWith("homeio-smoke-"))) {
    execFileSync("docker", ["compose", "-p", Name, "down", "-v"], { stdio: "pipe" });
    console.log(`stopped ${Name}`);
  }
  process.exit(0);
}
const ids = process.argv.slice(2).filter((arg) => arg !== "--keep");
if (ids.length === 0) {
  console.error("usage: node scripts/smoke.mjs [--keep] <appId> [appId ...]");
  process.exit(2);
}

const docker = (args, options = {}) => execFileSync("docker", args, { stdio: "pipe", ...options });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** First port from `start` that nothing listens on, so runs never step on each other. */
async function freePort(start) {
  for (let port = start; ; port++) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
}

/** Files a container wrote may belong to another user, so let Docker remove them. */
function removeTmp(tmp) {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    try { docker(["run", "--rm", "-v", `${tmp}:/d`, "alpine:3.20", "sh", "-c", "rm -rf /d/* /d/.[!.]*"]); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Homeio creates an app's folders as root and hands them to the user the
 * service runs as: its `user:`, or failing that PUID/PGID. A service with
 * neither keeps a root-owned folder. Do the same here, so a start that would
 * fail on a real install fails here too.
 */
function chownBindMounts(composeText, tmp, appId) {
  const services = yaml.load(composeText.replaceAll("$AppID", appId)).services ?? {};
  for (const service of Object.values(services)) {
    const env = Array.isArray(service.environment)
      ? Object.fromEntries(service.environment.map((e) => String(e).split("=")))
      : (service.environment ?? {});
    const user = String(service.user ?? "");
    const owner = /^\d+:\d+$/.test(user)
      ? user
      : /^\d+$/.test(String(env.PUID ?? "")) && /^\d+$/.test(String(env.PGID ?? ""))
        ? `${env.PUID}:${env.PGID}`
        : "0:0";
    for (const volume of service.volumes ?? []) {
      if (volume.type !== "bind" || !volume.source.startsWith(tmp)) continue;
      mkdirSync(volume.source, { recursive: true });
      docker(["run", "--rm", "-v", `${volume.source}:/d`, "alpine:3.20", "chown", "-R", owner, "/d"]);
    }
  }
}

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
for (const id of ids) {
  const meta = yaml.load(readFileSync(path.join(root, "Apps", id, "homeio.yml"), "utf8"));
  const tmp = mkdtempSync(path.join(os.tmpdir(), `homeio-store-${id}-`));
  const hostPort = await freePort(29000);
  const project = `homeio-smoke-${id}`;

  // Bind mounts go to a temp folder and the web port moves out of the way, so
  // the test cannot collide with anything already running on this machine.
  const compose = readFileSync(path.join(root, "Apps", id, "docker-compose.yml"), "utf8")
    .replaceAll("/DATA/AppData", tmp)
    .replace(/published: "\d+"/, `published: "${hostPort}"`)
    .replace(/^\s*container_name: .*\n/m, "");
  const composePath = path.join(tmp, "docker-compose.yml");
  writeFileSync(composePath, compose);
  chownBindMounts(compose, tmp, id);
  const env = { ...process.env, AppID: id };

  try {
    console.log(`${id}: pulling and starting`);
    docker(["compose", "-p", project, "-f", composePath, "up", "-d", "--pull", "missing"], { env });
    const scheme = meta.scheme ?? "http";
    // Self-hosted apps on https mostly carry a certificate nobody signed.
    if (scheme === "https") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const url = `${scheme}://localhost:${hostPort}${meta.index ?? "/"}`;
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
    if (!keep) {
      try { docker(["compose", "-p", project, "-f", composePath, "down", "-v"], { env }); } catch {}
      removeTmp(tmp);
      // A CI runner's disk does not hold every image of a big change at once.
      if (process.env.CI) { try { docker(["image", "prune", "-af"]); } catch {} }
    }
  }
}
process.exit(failed ? 1 : 0);
