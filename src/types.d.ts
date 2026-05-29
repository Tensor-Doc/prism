declare module "*.wgsl?raw" {
  const content: string;
  export default content;
}

declare module "butterchurn" {
  export interface Visualizer {
    connectAudio(node: AudioNode): void;
    loadPreset(preset: unknown, blendTime?: number): void;
    setRendererSize(width: number, height: number): void;
    render(): void;
    loadExtraImages(
      images: Record<string, { data: string; width: number; height: number }>,
    ): void;
  }
  const butterchurn: {
    createVisualizer(
      audioContext: AudioContext,
      canvas: HTMLCanvasElement,
      options: { width: number; height: number; pixelRatio?: number; textureRatio?: number },
    ): Visualizer;
  };
  export default butterchurn;
}

declare module "butterchurn-presets" {
  type PresetMap = Record<string, unknown>;
  const getPresets: () => PresetMap;
  export default getPresets;
}
