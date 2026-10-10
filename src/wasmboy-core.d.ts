declare module 'wasmboy/dist/core/core.esm.js' {
  export const memory: {
    wasmByteMemory: Uint8ClampedArray;
    size(): number;
    grow(pages: number): void;
  };

  export const FRAME_LOCATION: number;
  export const AUDIO_BUFFER_LOCATION: number;
  export const CARTRIDGE_RAM_LOCATION: number;
  export const CARTRIDGE_ROM_LOCATION: number;

  export function config(
    enableBootRom: number,
    useGbcWhenAvailable: number,
    audioBatchProcessing: number,
    graphicsBatchProcessing: number,
    timersBatchProcessing: number,
    graphicsDisableScanlineRendering: number,
    audioAccumulateSamples: number,
    tileRendering: number,
    tileCaching: number,
    enableAudioDebugging: number,
  ): void;
  export function executeFrameAndCheckAudio(maxAudioBuffer?: number): number;
  export function setJoypadState(
    up: number,
    right: number,
    down: number,
    left: number,
    a: number,
    b: number,
    select: number,
    start: number,
  ): void;
  export function getNumberOfSamplesInAudioBuffer(): number;
  export function clearAudioBuffer(): void;
}
