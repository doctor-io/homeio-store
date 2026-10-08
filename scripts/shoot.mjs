// Drives headless Chrome to take a screenshot, optionally after a few steps.
// Run: node scripts/shoot.mjs <out.png> <url> [step ...]
//   wait=<ms>            sleep
//   waitfor=<css>        wait until the selector exists
//   type=<css>::<text>   focus the field and type the text
//   click=<css>          click the element
//   eval=<js>            run a script in the page
//   log=<js>             same, and print what it returns
// Needs Google Chrome (CHROME env var to point elsewhere). No npm dependency.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const [out, url, ...steps] = process.argv.slice(2);
if (!out || !url) {
  console.error("usage: node scripts/shoot.mjs <out.png> <url> [step ...]");
  process.exit(2);
}
const chromePath = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(path.join(os.tmpdir(), "homeio-shoot-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chrome = spawn(chromePath, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--window-size=1280,800", "about:blank",
], { stdio: "ignore" });

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
    } catch { await sleep(200); }
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    pending.get(message.id)?.(message);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });
  const run = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return result.result?.value;
  };

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  await sleep(2500);

  for (const step of steps) {
    const at = step.indexOf("=");
    const [kind, arg] = [step.slice(0, at), step.slice(at + 1)];
    if (kind === "wait") await sleep(Number(arg));
    else if (kind === "eval") await run(arg);
    else if (kind === "log") console.log(JSON.stringify(await run(arg)));
    else if (kind === "click") await run(`document.querySelector(${JSON.stringify(arg)})?.click()`);
    else if (kind === "waitfor") {
      for (let i = 0; i < 100 && !(await run(`!!document.querySelector(${JSON.stringify(arg)})`)); i++) await sleep(300);
    } else if (kind === "type") {
      const [selector, text] = arg.split("::");
      await run(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
      await send("Input.insertText", { text });
    } else throw new Error(`unknown step "${step}"`);
  }

  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(data, "base64"));
  console.log(out);
  socket.close();
} finally {
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  chrome.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
