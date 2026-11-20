import { TransitionSeries, type TransitionPresentation } from "@remotion/transitions";
import { AbsoluteFill } from "remotion";
import { AA_THEME, AspectSchema, Stage } from "../components/primitives/Stage.js";
import { CaptionLayer } from "../components/primitives/CaptionLayer.js";
import { AudioBed, Narration } from "../components/primitives/AudioTracks.js";
import { transitionPreset } from "../components/primitives/TransitionPresets.js";
import { compile } from "../ir/compile.js";
import { registry } from "../ir/registry.js";

export type VideoFromIRProps = {
  aspect: "16:9" | "9:16" | "1:1";
  ir: unknown;
  timings: unknown;
};

export function VideoFromIR({ aspect: rawAspect, ir, timings }: VideoFromIRProps) {
  const aspect = AspectSchema.parse(rawAspect);
  const timeline = compile(ir, timings);
  if (!timeline.aspects.includes(aspect)) throw new Error(`IR does not request ${aspect}`);
  const elements: React.ReactNode[] = [];
  timeline.scenes.forEach((scene, index) => {
    if (index > 0 && scene.transitionIn !== "cut") {
      const preset = transitionPreset(scene.transitionIn, AA_THEME.tokens.colours.primary);
      if (!preset) throw new Error(`Missing transition preset for ${scene.id}`);
      elements.push(<TransitionSeries.Transition key={`transition-${scene.id}`} presentation={preset.presentation as TransitionPresentation<any>} timing={preset.timing} />);
    }
    const entry = registry[scene.component];
    const Component = entry.Component as React.ComponentType<any>;
    elements.push(<TransitionSeries.Sequence key={scene.id} durationInFrames={scene.durationInFrames}>
      <AbsoluteFill style={{ background: AA_THEME.tokens.colours.background }}>
        <Component {...scene.props} />
        {scene.captions.length > 0 && <CaptionLayer captions={scene.captions} textRegion={entry.textRegion(aspect)} />}
      </AbsoluteFill>
    </TransitionSeries.Sequence>);
  });
  const narration = timeline.scenes.filter((scene) => scene.audioSrc).map((scene) => ({
    src: scene.audioSrc!, from: scene.startFrame, durationInFrames: scene.audioDurationInFrames,
  }));
  const speechIntervals: [number, number][] = narration.map((scene) => [scene.from / timeline.fps, (scene.from + scene.durationInFrames) / timeline.fps]);
  return <Stage aspect={aspect} theme={AA_THEME}>
    <TransitionSeries>{elements}</TransitionSeries>
    {narration.length > 0 && <Narration scenes={narration} />}
    {timeline.music.enabled && timeline.musicSrc && <AudioBed musicSrc={timeline.musicSrc} speechIntervals={speechIntervals} />}
  </Stage>;
}
