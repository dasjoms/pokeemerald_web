export const WHEEL_SIZE = 32;

export function wrap32(v: number): number {
  const m = v % WHEEL_SIZE;
  return m < 0 ? m + WHEEL_SIZE : m;
}

export function wheelIndex(x: number, y: number): number {
  return wrap32(y) * WHEEL_SIZE + wrap32(x);
}
