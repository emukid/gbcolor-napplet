// Appended inside WasmBoy 0.7.1's module by build/core-snapshot.js.
// Keep the schema/version pinned: these are private emulator implementation details.
const snapshotClasses = {
  Config, Colors, Palette, TileCache, Channel1, Channel2, Channel3, Channel4,
  SoundAccumulator, Sound, Interrupts, Timers, Serial, Joypad, Breakpoints,
  Lcd, Graphics, Memory, Cpu, Cycles, Execute,
};
const snapshotFields = Object.fromEntries(Object.entries(snapshotClasses).map(([name, object]) => [
  name, Object.keys(object).filter((key) => typeof object[key] !== 'function'),
]));

export function captureSnapshotRegisters() {
  return Object.fromEntries(Object.entries(snapshotClasses).map(([name, object]) => [
    name, Object.fromEntries(snapshotFields[name].map((key) => [key, object[key]])),
  ]));
}

export function validateSnapshotRegisters(registers) {
  if (!registers || typeof registers !== 'object' || Array.isArray(registers)
    || Object.keys(registers).length !== Object.keys(snapshotClasses).length) {
    throw new Error('Invalid save state registers');
  }
  for (const [name, object] of Object.entries(snapshotClasses)) {
    const values = registers[name];
    if (!values || typeof values !== 'object' || Array.isArray(values)
      || Object.keys(values).length !== snapshotFields[name].length) throw new Error('Invalid save state registers');
    for (const key of snapshotFields[name]) {
      const value = values[key];
      // The pinned core stores scalar state only. Reject rather than silently lose new types.
      if (!Object.hasOwn(values, key) || typeof value !== typeof object[key]
        || !(typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) {
        throw new Error('Invalid save state register: ' + name + '.' + key);
      }
    }
  }
}

export function restoreSnapshotRegisters(registers) {
  validateSnapshotRegisters(registers);
  for (const [name, object] of Object.entries(snapshotClasses)) {
    for (const key of snapshotFields[name]) object[key] = registers[name][key];
  }
  hasStarted = true;
}
