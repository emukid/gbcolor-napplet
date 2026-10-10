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
  export const GAMEBOY_INTERNAL_MEMORY_LOCATION: number;
  export const GAMEBOY_INTERNAL_MEMORY_SIZE: number;
  export const GRAPHICS_OUTPUT_LOCATION: number;
  export const GRAPHICS_OUTPUT_SIZE: number;
  export const CARTRIDGE_RAM_SIZE: number;
  export function captureSnapshotRegisters(): Record<string, Record<string, number | boolean>>;
  export function validateSnapshotRegisters(registers: unknown): void;
  export function restoreSnapshotRegisters(registers: Record<string, Record<string, number | boolean>>): void;

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
