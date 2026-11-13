// Speak each beat with one Edge voice and one rate (one continuous read); write per-beat mp3 + timings.
// Usage: node voice.mjs <matchCount> [beatId ...]   (with beat ids, only those are re-voiced)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const s = JSON.parse(readFileSync("script.json", "utf8"));
const matches = process.argv[2] || "40";
const only = process.argv.slice(3);
const prev = existsSync("out/voice.json") ? Object.fromEntries(JSON.parse(readFileSync("out/voice.json", "utf8")).map((b) => [b.id, b])) : {};
const out = [];
for (const b of s.beats) {
  const text = b.text.replace("{MATCHES}", matches);
  if (only.length && !only.includes(b.id) && prev[b.id]) {
    out.push(prev[b.id]);
    continue;
  }
  for (let i = 0; ; i++) {
    try {
      execFileSync("edge-tts", ["--voice", s.voice, `--rate=${s.rate}`, "--text", text, "--write-media", `out/vo-${b.id}.mp3`, "--write-subtitles", `out/vo-${b.id}.srt`], { stdio: "pipe" });
      break;
    } catch (e) {
      if (i === 3) throw e; // Edge sometimes drops a request; try again
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `out/vo-${b.id}.mp3`]).toString().trim());
  out.push({ id: b.id, text, dur });
  console.log(b.id, dur.toFixed(2) + "s", (text.split(" ").length / dur).toFixed(2), "w/s");
}
writeFileSync("out/voice.json", JSON.stringify(out, null, 1));
console.log("total", out.reduce((a, b) => a + b.dur, 0).toFixed(1) + "s");
