import { Audio } from "@remotion/media";
import { Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";

export const SpeechIntervalSchema = z.tuple([z.number().finite().nonnegative(), z.number().finite().positive()]).refine(([start, end]) => end > start);
export const AudioBedSchema = z.strictObject({
  musicSrc: z.string().min(1),
  speechIntervals: z.array(SpeechIntervalSchema),
  bedDb: z.number().min(-60).max(0).default(-24),
  duckDb: z.number().min(-60).max(0).default(-14),
});
export type AudioBedProps = z.input<typeof AudioBedSchema>;

const dbToGain = (db: number) => 10 ** (db / 20);
export function musicGainAtFrame(frame: number, fps: number, intervals: [number, number][], bedDb: number, duckDb: number): number {
  const ramp = 12;
  const ducked = intervals.some(([start, end]) => frame >= Math.round(start * fps) - ramp && frame <= Math.round(end * fps) + ramp);
  if (!ducked) return dbToGain(bedDb);
  const distance = Math.min(...intervals.map(([start, end]) => {
    const first = Math.round(start * fps);
    const last = Math.round(end * fps);
    return frame < first ? first - frame : frame > last ? frame - last : 0;
  }));
  const blend = 1 - Math.min(1, distance / ramp);
  return dbToGain(bedDb + duckDb * blend);
}

export function AudioBed(props: AudioBedProps) {
  const { musicSrc, speechIntervals, bedDb, duckDb } = AudioBedSchema.parse(props);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <Audio src={musicSrc} loop volume={musicGainAtFrame(frame, fps, speechIntervals, bedDb, duckDb)} />;
}

export const NarrationSchema = z.strictObject({ scenes: z.array(z.strictObject({
  src: z.string().min(1), from: z.number().int().nonnegative(), durationInFrames: z.number().int().positive(),
})) });
export type NarrationProps = z.infer<typeof NarrationSchema>;
export function Narration(props: NarrationProps) {
  const { scenes } = NarrationSchema.parse(props);
  return <>{scenes.map((scene, index) => <Sequence key={`${index}-${scene.from}`} from={scene.from} durationInFrames={scene.durationInFrames}>
    <Audio src={scene.src} />
  </Sequence>)}</>;
}
