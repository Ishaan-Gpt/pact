// Assemble recorded scenes into one 720p30 MP4 with the voice: each scene's screencast frames become a
// constant-rate clip of exactly the scene length (last frame held), the voice beats sit at each scene start.
// Usage: node assemble.mjs [out.mp4]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const plan = JSON.parse(readFileSync("plan.json", "utf8"));
const out = process.argv[2] || "out/pact-demo.mp4";
const clips = [], audio = [];
let at = 0;
for (const s of plan.scenes) {
  const { dur, frames } = JSON.parse(readFileSync(`out/frames/${s.id}/frames.json`, "utf8"));
  const t0 = frames[0].t;
  let list = "";
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t - t0 : dur;
    const d = Math.max(0.001, next - (f.t - t0));
    list += `file '${f.file.replace(/^out\//, "")}'\nduration ${d.toFixed(4)}\n`;
  });
  list += `file '${frames.at(-1).file.replace(/^out\//, "")}'\n`;
  writeFileSync(`out/${s.id}.txt`, list);
  const clip = `out/clip-${s.id}.mp4`;
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", `out/${s.id}.txt`,
    "-vf", `fps=30,scale=1280:720:flags=lanczos,format=yuv420p`, "-t", dur.toFixed(3), "-c:v", "libx264", "-preset", "slow", "-crf", "18", clip]);
  clips.push(clip);
  const vo = `out/vo-${s.voice ?? s.id}.mp3`;
  if (existsSync(vo)) audio.push({ file: vo, at: at + 0.12 });
  at += dur;
}
writeFileSync("out/clips.txt", clips.map((c) => `file '${c.replace(/^out\//, "")}'`).join("\n"));
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", "out/clips.txt", "-c", "copy", "out/video-only.mp4"]);
const inputs = audio.flatMap((a) => ["-i", a.file]);
const filters = audio.map((a, i) => `[${i + 1}:a]adelay=${Math.round(a.at * 1000)}|${Math.round(a.at * 1000)}[a${i}]`).join(";") +
  `;${audio.map((_, i) => `[a${i}]`).join("")}amix=inputs=${audio.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
execFileSync("ffmpeg", ["-y", "-v", "error", "-i", "out/video-only.mp4", ...inputs, "-filter_complex", filters, "-map", "0:v", "-map", "[aout]",
  "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out]);
console.log(`wrote ${out}, ${at.toFixed(1)} s`);
