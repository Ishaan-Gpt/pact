// Records the Pact demo from the real running app: one headless Chrome, scene by scene, captions synced to
// the voice timings (out/voice.json), frames from the DevTools screencast. Assemble with assemble.mjs.
// Usage: node record.mjs [sceneId ...]   (default: all scenes in plan.json)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const W = 1280, H = 720, BASE = "http://localhost:8787";
const voice = Object.fromEntries(JSON.parse(readFileSync("out/voice.json", "utf8")).map((v) => [v.id, v]));
const plan = JSON.parse(readFileSync("plan.json", "utf8"));
const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const profile = join(tmpdir(), `pact-rec-${process.pid}`);
const port = 9400 + Math.floor(Math.random() * 400);
const proc = spawn(browser, ["--headless=new", `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, "--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
  "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try {
    const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {}
  if (!ws) await sleep(200);
}
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
let onFrame = null;
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) pending.get(m.id)(m), pending.delete(m.id);
  if (m.method === "Page.screencastFrame") {
    send("Page.screencastFrameAck", { sessionId: m.params.sessionId });
    onFrame?.(m.params);
  }
  if (m.method === "Runtime.exceptionThrown") console.log("page exception:", m.params.exceptionDetails.exception?.description?.slice(0, 200));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `try{sessionStorage.setItem("pact-intro","1")}catch(e){}` });

// Captions: chunks of ~7 words, timed by character share of the beat; drawn in the page in the site's own type.
function chunks(text, dur) {
  const words = text.split(" "), out = [];
  for (let i = 0; i < words.length; ) {
    let n = Math.min(7, words.length - i);
    if (words.length - (i + n) > 0 && words.length - (i + n) < 3) n = words.length - i; // no orphan tail
    out.push(words.slice(i, i + n).join(" "));
    i += n;
  }
  const total = out.reduce((a, c) => a + c.length, 0);
  let t = 0.15;
  return out.map((c) => { const d = (c.length / total) * (dur - 0.25); const r = { at: t, text: c }; t += d; return r; });
}
const CAPTION_CSS = `#pact-cap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:99;max-width:980px;padding:.55rem 1.1rem .6rem;border-radius:14px;
  background:color-mix(in oklch, var(--p-900) 88%, transparent);color:var(--c-50);font:500 25px/1.3 "Hanken Grotesk",system-ui;text-align:center;letter-spacing:.005em;
  transition:opacity .18s ease;box-shadow:0 10px 30px -18px var(--p-900)}`;

const actions = {
  async type(sel, text, cps = 38) {
    await js(`document.querySelector(${JSON.stringify(sel)}).focus()`);
    for (const ch of text) {
      await send("Input.insertText", { text: ch });
      await sleep(1000 / cps);
    }
  },
  async click(sel) { await js(`document.querySelector(${JSON.stringify(sel)}).click()`); },
  async scrollTo(sel, ms = 900) {
    await js(`(()=>{const y=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().top+scrollY-20,y0=scrollY,t0=performance.now();
      return new Promise(r=>{const f=n=>{const p=Math.min(1,(n-t0)/${ms}),e=p<.5?4*p*p*p:1-Math.pow(-2*p+2,3)/2;scrollTo(0,y0+(y-y0)*e);p<1?requestAnimationFrame(f):r()};requestAnimationFrame(f)})})()`);
  },
  async glide(px, ms) {
    await js(`(()=>{const y0=scrollY,t0=performance.now();return new Promise(r=>{const f=n=>{const p=Math.min(1,(n-t0)/${ms});scrollTo(0,y0+${px}*(p<.5?2*p*p:1-Math.pow(-2*p+2,2)/2));p<1?requestAnimationFrame(f):r()};requestAnimationFrame(f)})})()`);
  },
  async jump(sel) { await js(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView()`); },
  async wait(ms) { await sleep(ms); },
  async waitFor(expr, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms && !(await js(`!!(${expr})`))) await sleep(150); },
  async eval(code) { await js(code); },
};

mkdirSync("out/frames", { recursive: true });
for (const scene of plan.scenes) {
  if (only.length && !only.includes(scene.id)) continue;
  const v = voice[scene.voice ?? scene.id];
  const dur = (v ? v.dur : scene.dur) + (scene.pad ?? 0.45);
  await send("Page.navigate", { url: BASE + scene.url });
  await sleep(scene.load ?? 2500);
  for (const a of scene.before ?? []) await actions[a[0]](...a.slice(1));
  await js(`(()=>{let s=document.getElementById("pact-cap-style");if(!s){s=document.createElement("style");s.id="pact-cap-style";s.textContent=${JSON.stringify(CAPTION_CSS)};document.head.append(s)}
    let c=document.getElementById("pact-cap");if(!c){c=document.createElement("div");c.id="pact-cap";document.body.append(c)}c.style.opacity=0;})()`);
  const caps = v ? chunks(v.text, v.dur) : [];
  if (scene.endCard) caps.push({ at: dur - 2.4, text: scene.endCard });

  const dir = `out/frames/${scene.id}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames = [];
  onFrame = (p) => {
    const f = `${dir}/${String(frames.length).padStart(5, "0")}.jpg`;
    writeFileSync(f, Buffer.from(p.data, "base64"));
    frames.push({ file: f, t: p.metadata.timestamp });
  };
  await send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  const t0 = Date.now();
  // captions run on their own clock in the page
  await js(`(()=>{const c=document.getElementById("pact-cap");${JSON.stringify(caps)}.forEach(k=>setTimeout(()=>{c.textContent=k.text;c.style.opacity=1},k.at*1000));})()`);
  // actions run strictly in order, each no earlier than its time: a slow keystroke never lets the next field steal focus
  const timeline = [(async () => { for (const a of scene.during ?? []) { await sleep(Math.max(0, a[0] * 1000 - (Date.now() - t0))); await actions[a[1]](...a.slice(2)); } })()];
  await Promise.all([...timeline, sleep(dur * 1000)]);
  await sleep(Math.max(0, dur * 1000 - (Date.now() - t0)));
  await send("Page.stopScreencast");
  onFrame = null;
  writeFileSync(`${dir}/frames.json`, JSON.stringify({ dur, frames }, null, 0));
  console.log(`${scene.id}: ${frames.length} frames over ${dur.toFixed(2)} s`);
  for (const a of scene.after ?? []) await actions[a[0]](...a.slice(1));
}
ws.close();
proc.kill();
await sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
