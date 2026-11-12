// The arena: two carved seal stones on a porcelain table. A match is a script of beats; the canvas plays it.
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const ease = {
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  back: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2),
};
const BASE = 0.6; // the table line, as a share of the height
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));

// Stone glazes, all from the page ramps (celadon, plum, a pale bone-celadon).
const GLAZES = [
  { top: "--c-300", body: "--c-500", dark: "--c-800", carve: "--c-800" },
  { top: "--p-300", body: "--p-500", dark: "--p-900", carve: "--p-900" },
  { top: "--c-100", body: "--c-300", dark: "--c-700", carve: "--c-700" },
];
const glazeFor = (id) => GLAZES[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % GLAZES.length];

export class Arena {
  constructor(canvas, caption) {
    this.c = canvas;
    this.x = canvas.getContext("2d");
    this.caption = caption;
    this.t0 = performance.now();
    this.script = null;
    this.onDone = null;
    this.visible = true;
    new ResizeObserver(() => this.resize()).observe(canvas);
    new IntersectionObserver(([e]) => (this.visible = e.isIntersecting)).observe(canvas);
    this.resize();
    requestAnimationFrame((t) => this.frame(t));
  }

  resize() {
    const r = this.c.getBoundingClientRect();
    const d = Math.min(devicePixelRatio || 1, 2);
    this.c.width = Math.round(r.width * d);
    this.c.height = Math.round(r.height * d);
    this.W = r.width;
    this.H = r.height;
    this.x.setTransform(d, 0, 0, d, 0, 0);
  }

  /** match = { a:{id,name}, b:{id,name}, stake, transcript:[{who,line}], moves:{id:"Split"|"Steal"},
   *  reveals:{id:text}, payout:{id:near, jackpot}, sigs:{id:"model:req:resp"}, matchId, live? } */
  play(match, onDone) {
    this.match = match;
    this.onDone = onDone;
    const beats = [];
    let t = 0.6;
    const add = (kind, dur, extra = {}) => (beats.push({ kind, at: t, dur, ...extra }), (t += dur));
    add("enter", 1.2);
    for (const l of match.transcript || []) add("talk", Math.max(2.6, 0.9 + l.line.length * 0.045), l);
    if (match.moves) {
      add("decide", 1.8);
      add("reveal", 2.6);
      add("settle", 3.4);
    } else add("wait", 9999);
    this.beats = beats;
    this.start = performance.now();
    this.length = t;
    this.caption.innerHTML = `<span>match ${match.matchId ?? "live"} · stake ${match.stake} NEAR each</span><span>${match.live ? "running in the enclave" : "replay from the contract"}</span>`;
  }

  /** Live matches grow: append a talk line or the result while playing. */
  extend(match) {
    const elapsed = (performance.now() - this.start) / 1000;
    this.match = match;
    const done = this.beats.filter((b) => b.kind !== "wait");
    let t = Math.max(elapsed, done.length ? done.at(-1).at + done.at(-1).dur : 0.6);
    const beats = [...done];
    const add = (kind, dur, extra = {}) => (beats.push({ kind, at: t, dur, ...extra }), (t += dur));
    const said = done.filter((b) => b.kind === "talk").length;
    for (const l of (match.transcript || []).slice(said)) add("talk", Math.max(2.6, 0.9 + l.line.length * 0.045), l);
    if (match.moves && !done.some((b) => b.kind === "decide")) {
      add("decide", 1.8);
      add("reveal", 2.6);
      add("settle", 3.4);
    } else if (!match.moves) add("wait", 9999);
    this.beats = beats;
    this.length = t;
  }

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    if (!this.visible || !this.W) return;
    const time = (now - this.t0) / 1000;
    const e = this.match ? (now - this.start) / 1000 : 0;
    const x = this.x;
    x.clearRect(0, 0, this.W, this.H);
    this.drawTable(time);
    if (!this.match) return;
    const st = this.state(e);
    this.drawPot(st, time);
    this.drawStone(this.match.a, -1, st, time);
    this.drawStone(this.match.b, 1, st, time);
    this.drawTalk(st);
    if (e > this.length + 0.5 && this.onDone) {
      const cb = this.onDone;
      this.onDone = null;
      cb();
    }
  }

  state(e) {
    const s = { enter: 0, talk: null, decide: 0, reveal: 0, settle: 0, said: [] };
    for (const b of this.beats) {
      const p = clamp((e - b.at) / b.dur);
      if (e < b.at) continue;
      if (b.kind === "enter") s.enter = p;
      if (b.kind === "talk") (p < 1 ? (s.talk = { ...b, p }) : null), s.said.push(b);
      if (b.kind === "decide") s.decide = p;
      if (b.kind === "reveal") s.reveal = p;
      if (b.kind === "settle") s.settle = p;
    }
    return s;
  }

  drawTable(time) {
    const { x, W, H } = this;
    // glaze crackle: a few fixed faint arcs, so the porcelain reads as a material, not a flat fill
    x.save();
    x.strokeStyle = css("--c-300");
    x.globalAlpha = 0.25;
    x.lineWidth = 0.6;
    for (let i = 0; i < 14; i++) {
      const r = 40 + ((i * 97) % 220);
      x.beginPath();
      x.arc(((i * 173) % 1000) / 1000 * W, ((i * 311) % 1000) / 1000 * H, r, i, i + 0.7);
      x.stroke();
    }
    x.restore();
    // the table line
    x.fillStyle = css("--c-200");
    x.globalAlpha = 0.5;
    x.fillRect(0, H * BASE, W, 1);
    x.globalAlpha = 1;
  }

  stonePos(side, st, time) {
    const { W, H } = this;
    const enterX = (1 - ease.out(st.enter)) * side * W * 0.35;
    const lift = st.decide ? ease.inOut(st.decide) * H * 0.1 : 0;
    const stamp = st.reveal ? (st.reveal < 0.35 ? ease.back(st.reveal / 0.35) : 1) : 0;
    const y = H * BASE - lift + stamp * lift - Math.sin(time * 1.3 + side) * 2 * (1 - st.decide);
    return { cx: W / 2 + side * W * 0.27 + enterX, y, lift: lift * (1 - stamp) };
  }

  drawStone(agent, side, st, time) {
    const { x, H } = this;
    const g = glazeFor(agent.id);
    const s = Math.min(this.W, H * 1.4) * 0.16; // stone width
    const h = s * 0.95;
    const { cx, y, lift } = this.stonePos(side, st, time);
    const speaking = st.talk && st.talk.who === agent.id;
    const tilt = speaking ? Math.sin(st.talk.p * Math.PI) * 0.05 * -side : 0;

    // contact shadow: tighter and darker as the stone comes down
    const sh = 1 - clamp(lift / (H * 0.1));
    x.save();
    x.translate(cx, H * BASE);
    x.scale(1, 0.22);
    const grd = x.createRadialGradient(0, 0, 2, 0, 0, s * (0.9 + (1 - sh) * 0.5));
    grd.addColorStop(0, `rgba(30,20,28,${0.28 * sh + 0.06})`);
    grd.addColorStop(1, "rgba(30,20,28,0)");
    x.fillStyle = grd;
    x.beginPath();
    x.arc(0, 0, s * 1.4, 0, Math.PI * 2);
    x.fill();
    x.restore();

    // the impression it leaves (after the stamp)
    if (st.reveal > 0.3 && this.match.moves) this.drawImpression(agent, side, cx, st);

    x.save();
    x.translate(cx, y);
    x.rotate(tilt);
    // body: a rounded block lit from the upper left
    const body = x.createLinearGradient(-s / 2, 0, s / 2, 0);
    body.addColorStop(0, css(g.top));
    body.addColorStop(0.45, css(g.body));
    body.addColorStop(1, css(g.dark));
    x.fillStyle = body;
    roundRect(x, -s / 2, -h, s, h, s * 0.16);
    x.fill();
    // bevelled top face
    const top = x.createLinearGradient(0, -h - s * 0.12, 0, -h + s * 0.2);
    top.addColorStop(0, css(g.top));
    top.addColorStop(1, css(g.body));
    x.fillStyle = top;
    x.beginPath();
    x.ellipse(0, -h + s * 0.02, s / 2 - 1, s * 0.13, 0, 0, Math.PI * 2);
    x.fill();
    // carved initial on the front face
    x.fillStyle = css(g.carve);
    x.globalAlpha = 0.55;
    x.font = `${s * 0.42}px Gloock, Georgia, serif`;
    x.textAlign = "center";
    x.fillText(agent.name[0].toUpperCase(), 0, -h * 0.38);
    x.globalAlpha = 1;
    // a soft specular streak
    x.fillStyle = "rgba(255,255,255,0.18)";
    roundRect(x, -s * 0.36, -h * 0.9, s * 0.07, h * 0.7, s * 0.04);
    x.fill();
    x.restore();

    // name and record below the table line
    x.fillStyle = css("--ink");
    x.font = `${Math.max(14, s * 0.2)}px Gloock, Georgia, serif`;
    x.textAlign = "center";
    x.fillText(agent.name, cx, H * BASE + s * 0.36);
    if (st.settle > 0 && this.match.payout) {
      const won = this.match.payout[agent.id] - this.match.stake;
      const a = ease.out(clamp(st.settle * 2));
      x.globalAlpha = a;
      x.font = `500 ${Math.max(11, s * 0.12)}px "Martian Mono", monospace`;
      x.fillStyle = won > 0 ? css("--r-600") : won < 0 ? css("--p-500") : css("--c-700");
      x.fillText(`${won > 0 ? "+" : ""}${won.toFixed(2)} NEAR`, cx, H * BASE + s * 0.56);
      x.globalAlpha = 1;
    }
  }

  drawImpression(agent, side, cx, st) {
    const { x, H } = this;
    const mv = this.match.moves[agent.id];
    const s = Math.min(this.W, H * 1.4) * 0.16;
    const p = ease.out(clamp((st.reveal - 0.3) / 0.4));
    const ink = mv === "Steal" ? css("--r-500") : css("--c-600");
    const iy = H * 0.80;
    const ix = cx;
    x.save();
    x.translate(ix, iy);
    x.rotate(side * 0.035);
    x.globalAlpha = 0.92 * p;
    x.strokeStyle = ink;
    x.lineWidth = Math.max(2, s * 0.03);
    const w = s * 1.15, hh = s * 0.42;
    roundRect(x, -w / 2, -hh / 2, w, hh, 6);
    x.stroke();
    x.fillStyle = ink;
    x.font = `${hh * 0.62}px Gloock, Georgia, serif`;
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.fillText(mv.toUpperCase(), 0, 2);
    x.restore();
    const sig = this.match.sigs?.[agent.id];
    if (sig && st.reveal > 0.6) {
      const n = Math.floor(clamp((st.reveal - 0.6) / 0.4) * 16);
      const hash = sig.split(":").at(-1).slice(0, n);
      x.font = `400 ${Math.max(9, s * 0.075)}px "Martian Mono", monospace`;
      x.fillStyle = css("--c-700");
      x.textAlign = "center";
      x.fillText(`signed in enclave ${hash}`, ix, iy + s * 0.36);
    }
  }

  drawPot(st, time) {
    const { x, W, H } = this;
    const s = Math.min(W, H * 1.4) * 0.16;
    const pot = this.match.stake * 2;
    const cx = W / 2;
    let px = cx, alpha = 1;
    if (st.settle > 0 && this.match.payout) {
      // coins slide to whoever took money home (or fade to the jackpot)
      const pa = this.match.payout[this.match.a.id], pb = this.match.payout[this.match.b.id];
      const target = pa > pb ? -1 : pb > pa ? 1 : 0;
      px = cx + target * W * 0.27 * ease.inOut(clamp(st.settle * 1.6));
      if (this.match.payout.jackpot > 0) alpha = 1 - clamp(st.settle * 1.5);
      if (target === 0 && this.match.payout.jackpot === 0) alpha = 1 - clamp(st.settle * 1.5) * 0.6;
    }
    x.save();
    x.globalAlpha = alpha * ease.out(st.enter);
    const n = 5;
    for (let i = 0; i < n; i++) {
      const y = H * (BASE - 0.01) - i * s * 0.08;
      const g = x.createLinearGradient(px - s * 0.3, 0, px + s * 0.3, 0);
      g.addColorStop(0, css("--c-200"));
      g.addColorStop(1, css("--c-500"));
      x.fillStyle = g;
      x.beginPath();
      x.ellipse(px, y, s * 0.3, s * 0.085, 0, 0, Math.PI * 2);
      x.fill();
      x.strokeStyle = css("--c-600");
      x.globalAlpha *= 1;
      x.lineWidth = 1;
      x.stroke();
    }
    x.fillStyle = css("--ink");
    x.font = `500 ${Math.max(11, s * 0.12)}px "Martian Mono", monospace`;
    x.textAlign = "center";
    x.fillText(`${pot.toFixed(2)} NEAR`, px, H * (BASE - 0.01) - n * s * 0.08 - s * 0.18);
    x.restore();
  }

  drawTalk(st) {
    const { x, W, H } = this;
    const s = Math.min(W, H * 1.4) * 0.16;
    const lines = [];
    // the latest line of each agent stays faintly; the one being said types in
    for (const b of st.said) lines.push({ ...b, p: st.talk && st.talk.at === b.at ? st.talk.p : 1 });
    const latest = {};
    for (const l of lines) latest[l.who] = l;
    const fadeAll = st.decide > 0 ? 1 - ease.out(st.decide) * 0.6 : 1;
    for (const [who, l] of Object.entries(latest)) {
      const side = who === this.match.a.id ? -1 : 1;
      const typed = l.line.slice(0, Math.ceil(l.line.length * clamp(l.p * 1.6)));
      const isNow = st.talk && st.talk.at === l.at;
      x.globalAlpha = (isNow ? 1 : 0.45) * fadeAll;
      x.fillStyle = css("--ink");
      x.font = `${Math.max(14, s * 0.15)}px "Hanken Grotesk", system-ui, sans-serif`;
      x.textAlign = side < 0 ? "left" : "right";
      const maxW = W * 0.4;
      const left = side < 0 ? W * 0.05 : W * 0.95;
      wrap(x, typed, left, H * 0.1, maxW, Math.max(19, s * 0.21));
    }
    x.globalAlpha = 1;
    if (st.decide > 0 && st.reveal === 0) {
      x.fillStyle = css("--c-700");
      x.font = `400 ${Math.max(11, s * 0.1)}px "Martian Mono", monospace`;
      x.textAlign = "center";
      x.globalAlpha = 0.5 + 0.5 * Math.sin(st.decide * 10);
      x.fillText("both deciding inside the enclave", W / 2, H * 0.36);
      x.globalAlpha = 1;
    }
  }
}

function roundRect(x, X, Y, w, h, r) {
  x.beginPath();
  x.moveTo(X + r, Y);
  x.arcTo(X + w, Y, X + w, Y + h, r);
  x.arcTo(X + w, Y + h, X, Y + h, r);
  x.arcTo(X, Y + h, X, Y, r);
  x.arcTo(X, Y, X + w, Y, r);
  x.closePath();
}

function wrap(x, text, left, top, maxW, lh) {
  const words = text.split(" ");
  let line = "", y = top;
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (x.measureText(t).width > maxW && line) {
      x.fillText(line, left, y);
      line = w;
      y += lh;
    } else line = t;
  }
  if (line) x.fillText(line, left, y);
}
