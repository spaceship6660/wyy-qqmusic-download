// 大端 uint32 读写（tea.ts 用；避免对具体 Buffer 类型的依赖）

export function readUInt32BE(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0
}

export function writeUInt32BE(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v >>> 24
  buf[off + 1] = v >>> 16
  buf[off + 2] = v >>> 8
  buf[off + 3] = v
}

export function readUInt32LE(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
}