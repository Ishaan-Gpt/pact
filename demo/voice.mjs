// Speak each beat with one Edge voice and one rate (one continuous read), write per-beat mp3 + word timings.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const s = JSON.parse(readFileSync("script.json", "utf8"));
const matches = process.argv[2] || "40";
const out = [];
for (const b of s.beats) {
  const text = b.text.replace("{MATCHES}", matches);
  execFileSync("edge-tts", ["--voice", s.voice, `--rate=${s.rate}`, "--text", text, "--write-media", `out/vo-${b.id}.mp3`, "--write-subtitles", `out/vo-${b.id}.srt`]);
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `out/vo-${b.id}.mp3`]).toString().trim());
  const srt = readFileSync(`out/vo-${b.id}.srt`, "utf8");
  const cues = [...srt.matchAll(/(\d\d):(\d\d):(\d\d)[,.](\d\d\d) --> (\d\d):(\d\d):(\d\d)[,.](\d\d\d)\r?\n([\s\S]*?)(?:\r?\n\r?\n|$)/g)].map((m) => ({
    start: +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000,
    end: +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000,
    text: m[9].trim().replace(/\s+/g, " "),
  }));
  out.push({ id: b.id, text, dur, cues });
  console.log(b.id, dur.toFixed(2) + "s", cues.length, "cues", (text.split(" ").length / dur).toFixed(2), "w/s");
}
writeFileSync("out/voice.json", JSON.stringify(out, null, 1));
console.log("total", out.reduce((a, b) => a + b.dur, 0).toFixed(1) + "s");
