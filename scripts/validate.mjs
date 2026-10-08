// Static checks for every app. Run: node scripts/validate.mjs [appId ...]
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const root = path.resolve(import.meta.dirname, "..");
const errors = [];
const warnings = [];
const fail = (app, message) => errors.push(`${app}: ${message}`);

const store = yaml.load(readFileSync(path.join(root, "store.yml"), "utf8"));
if (store.format !== 1) errors.push("store.yml: format must be 1");
const categoryIds = new Set((store.categories ?? []).map((c) => c.id));

const isLocalized = (value) =>
  value && typeof value.en === "string" && value.en.trim() && typeof value.fr === "string" && value.fr.trim();

const appsDir = path.join(root, "Apps");
const requested = process.argv.slice(2);
const appIds = (requested.length ? requested : readdirSync(appsDir)).filter((id) =>
  existsSync(path.join(appsDir, id)),
);

for (const id of appIds) {
  const dir = path.join(appsDir, id);
  const metaPath = path.join(dir, "homeio.yml");
  const composePath = path.join(dir, "docker-compose.yml");
  if (!existsSync(metaPath)) { fail(id, "homeio.yml missing"); continue; }
  if (!existsSync(composePath)) { fail(id, "docker-compose.yml missing"); continue; }

  const meta = yaml.load(readFileSync(metaPath, "utf8"));
  const compose = yaml.load(readFileSync(composePath, "utf8"));

  if (meta.id !== id) fail(id, `homeio.yml id "${meta.id}" must match the folder name`);
  if (compose.name !== id) fail(id, `compose name "${compose.name}" must match the folder name`);
  for (const field of ["tagline", "description"]) {
    if (!isLocalized(meta[field])) fail(id, `${field} needs non-empty en and fr`);
  }
  if (typeof meta.name !== "string" || !meta.name.trim()) fail(id, "name missing");
  if (!categoryIds.has(meta.category)) fail(id, `category "${meta.category}" is not in store.yml`);
  if (!Number.isInteger(meta.port) || meta.port < 1 || meta.port > 65535) fail(id, "port must be 1-65535");

  const files = readdirSync(dir);
  if (!files.some((f) => /^icon\.(svg|png|webp)$/.test(f))) fail(id, "icon.svg|png|webp missing");
  const shots = existsSync(path.join(dir, "screenshots"))
    ? readdirSync(path.join(dir, "screenshots")).filter((f) => f.endsWith(".webp"))
    : [];
  if (shots.length > 3) fail(id, `${shots.length} screenshots, 3 at most`);
  if (shots.length === 0) warnings.push(`${id}: no screenshots yet`);

  const services = compose.services ?? {};
  const main = services[meta.main];
  if (!main) { fail(id, `main service "${meta.main}" is not in the compose`); continue; }

  for (const [name, service] of Object.entries(services)) {
    const image = String(service.image ?? "");
    const tag = image.slice(image.lastIndexOf(":") + 1);
    if (!image.includes(":") || tag.includes("/") || tag === "latest") {
      fail(id, `service "${name}" needs a pinned image tag, got "${image}"`);
    }
    for (const volume of service.volumes ?? []) {
      const source = typeof volume === "string" ? volume.split(":")[0] : volume.source;
      // Media apps share the user's own library: /DATA/Media and /DATA/Download.
      // The Docker socket is allowed for apps whose job is managing containers; the
      // description has to say so.
      const shared = /^\/DATA\/(Media|Download)(\/|$)/.test(source ?? "") || source === "/var/run/docker.sock";
      if (typeof source === "string" && source.startsWith("/") && !shared && !source.startsWith("/DATA/AppData/$AppID")) {
        fail(id, `service "${name}" mounts ${source}; app data must live under /DATA/AppData/$AppID (or the shared /DATA/Media and /DATA/Download)`);
      }
    }
  }

  const published = (main.ports ?? []).map((p) => Number(typeof p === "string" ? p.split(":").at(-2) : p.target));
  if (!published.includes(meta.port)) fail(id, `main service does not publish container port ${meta.port}`);

  const environment = main.environment ?? {};
  const envKeys = Array.isArray(environment) ? environment.map((e) => e.split("=")[0]) : Object.keys(environment);
  for (const [key, entry] of Object.entries(meta.env ?? {})) {
    if (!envKeys.includes(key)) fail(id, `env ${key} is described but not in the compose environment`);
    else {
      const value = Array.isArray(environment)
        ? environment.find((e) => e.startsWith(`${key}=`))?.slice(key.length + 1)
        : environment[key];
      // The answers land in the stack's .env, so the compose must read them.
      if (!String(value).includes(`\${${key}`)) fail(id, `env ${key} must be written as \${${key}:-default} in the compose`);
    }
    if (!isLocalized(entry.label) || !isLocalized(entry.description)) fail(id, `env ${key} needs label and description in en and fr`);
  }

  try {
    execFileSync("docker", ["compose", "-f", composePath, "config", "--quiet"], {
      env: { ...process.env, AppID: id },
      stdio: "pipe",
    });
  } catch (error) {
    fail(id, `docker compose config failed: ${String(error.stderr ?? error.message).trim()}`);
  }
}

for (const id of store.featured ?? []) {
  if (!existsSync(path.join(appsDir, id))) errors.push(`store.yml: featured app "${id}" does not exist`);
}

for (const warning of warnings) console.warn(`warn  ${warning}`);
for (const error of errors) console.error(`error ${error}`);
console.log(`${appIds.length} app(s) checked, ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
