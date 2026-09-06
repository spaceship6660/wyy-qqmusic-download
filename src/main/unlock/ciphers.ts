// QQ 音乐加密文件解密：三类流密码器（移植自 showhwa/UnlockMusicProject_Archive
// tmp/cli/algo/qmc/cipher_static.go / cipher_map.go / cipher_rc4.go，逐字节对应）。
// 全部按 Go 语义原地解密 buf（offset = 当前块的文件绝对偏移）。

export interface QmcStreamCipher {
  decrypt(buf: Uint8Array, offset: number): void
}

// --- static（cipher_static.go）：qmc0 老格式兜底，无密钥 ---

// staticCipherBox 256 字节表（cipher_static.go:20-83）
const STATIC_BOX = new Uint8Array([
  0x77, 0x48, 0x32, 0x73, 0xde, 0xf2, 0xc0, 0xc8, 0x95, 0xec, 0x30, 0xb2, 0x51, 0xc3, 0xe1, 0xa0,
  0x9e, 0xe6, 0x9d, 0xcf, 0xfa, 0x7f, 0x14, 0xd1, 0xce, 0xb8, 0xdc, 0xc3, 0x4a, 0x67, 0x93, 0xd6,
  0x28, 0xc2, 0x91, 0x70, 0xca, 0x8d, 0xa2, 0xa4, 0xf0, 0x08, 0x61, 0x90, 0x7e, 0x6f, 0xa2, 0xe0,
  0xeb, 0xae, 0x3e, 0xb6, 0x67, 0xc7, 0x92, 0xf4, 0x91, 0xb5, 0xf6, 0x6c, 0x5e, 0x84, 0x40, 0xf7,
  0xf3, 0x1b, 0x02, 0x7f, 0xd5, 0xab, 0x41, 0x89, 0x28, 0xf4, 0x25, 0xcc, 0x52, 0x11, 0xad, 0x43,
  0x68, 0xa6, 0x41, 0x8b, 0x84, 0xb5, 0xff, 0x2c, 0x92, 0x4a, 0x26, 0xd8, 0x47, 0x6a, 0x7c, 0x95,
  0x61, 0xcc, 0xe6, 0xcb, 0xbb, 0x3f, 0x47, 0x58, 0x89, 0x75, 0xc3, 0x75, 0xa1, 0xd9, 0xaf, 0xcc,
  0x08, 0x73, 0x17, 0xdc, 0xaa, 0x9a, 0xa2, 0x16, 0x41, 0xd8, 0xa2, 0x06, 0xc6, 0x8b, 0xfc, 0x66,
  0x34, 0x9f, 0xcf, 0x18, 0x23, 0xa0, 0x0a, 0x74, 0xe7, 0x2b, 0x27, 0x70, 0x92, 0xe9, 0xaf, 0x37,
  0xe6, 0x8c, 0xa7, 0xbc, 0x62, 0x65, 0x9c, 0xc2, 0x08, 0xc9, 0x88, 0xb3, 0xf3, 0x43, 0xac, 0x74,
  0x2c, 0x0f, 0xd4, 0xaf, 0xa1, 0xc3, 0x01, 0x64, 0x95, 0x4e, 0x48, 0x9f, 0xf4, 0x35, 0x78, 0x95,
  0x7a, 0x39, 0xd6, 0x6a, 0xa0, 0x6d, 0x40, 0xe8, 0x4f, 0xa8, 0xef, 0x11, 0x1d, 0xf3, 0x1b, 0x3f,
  0x3f, 0x07, 0xdd, 0x6f, 0x5b, 0x19, 0x30, 0x19, 0xfb, 0xef, 0x0e, 0x37, 0xf0, 0x0e, 0xcd, 0x16,
  0x49, 0xfe, 0x53, 0x47, 0x13, 0x1a, 0xbd, 0xa4, 0xf1, 0x40, 0x19, 0x60, 0x0e, 0xed, 0x68, 0x09,
  0x06, 0x5f, 0x4d, 0xcf, 0x3d, 0x1a, 0xfe, 0x20, 0x77, 0xe4, 0xd9, 0xda, 0xf9, 0xa4, 0x2b, 0x76,
  0x1c, 0x71, 0xdb, 0x00, 0xbc, 0xfd, 0x0c, 0x6c, 0xa5, 0x47, 0xf7, 0xf6, 0x00, 0x79, 0x4a, 0x11,
])

export function createStaticCipher(): QmcStreamCipher {
  return {
    decrypt(buf: Uint8Array, offset: number): void {
      for (let i = 0; i < buf.length; i++) buf[i] ^= staticMask(offset + i)
    },
  }
}

function staticMask(offset: number): number {
  if (offset > 0x7fff) offset %= 0x7fff
  return STATIC_BOX[(offset * offset + 27) & 0xff]
}

// --- map（cipher_map.go）：派生密钥 ≤300 字节 ---

export class MapCipher implements QmcStreamCipher {
  readonly key: Uint8Array
  readonly size: number

  constructor(key: Uint8Array) {
    if (key.length === 0) throw new Error('qmc/map: 密钥为空')
    this.key = key
    this.size = key.length
  }

  private rotate(value: number, bits: number): number {
    const r = (bits + 4) % 8
    return ((value << r) | (value >> r)) & 0xff
  }

  private getMask(offset: number): number {
    if (offset > 0x7fff) offset %= 0x7fff
    const idx = (offset * offset + 71214) % this.size
    return this.rotate(this.key[idx], idx & 0x7)
  }

  decrypt(buf: Uint8Array, offset: number): void {
    for (let i = 0; i < buf.length; i++) buf[i] ^= this.getMask(offset + i)
  }
}

// --- rc4（cipher_rc4.go）：派生密钥 >300 字节，分段式 ---

const RC4_SEGMENT_SIZE = 5120
const RC4_FIRST_SEGMENT_SIZE = 128

export class Rc4Cipher implements QmcStreamCipher {
  readonly key: Uint8Array
  readonly n: number
  private box: Uint8Array
  private hash = 1

  constructor(key: Uint8Array) {
    if (key.length === 0) throw new Error('qmc/rc4: 密钥为空')
    this.key = key
    this.n = key.length
    this.box = new Uint8Array(this.n)
    for (let i = 0; i < this.n; i++) this.box[i] = i
    let j = 0
    for (let i = 0; i < this.n; i++) {
      j = (j + this.box[i] + key[i % this.n]) % this.n
      const t = this.box[i]
      this.box[i] = this.box[j]
      this.box[j] = t
    }
    this.getHashBase()
  }

  /** getHashBase（cipher_rc4.go:44-55）：hash = 密钥字节连乘（uint32 回绕；遇 0 跳过、溢出即停） */
  private getHashBase(): void {
    let hash = 1
    for (let i = 0; i < this.n; i++) {
      const v = this.key[i]
      if (v === 0) continue
      const nextHash = Math.imul(hash, v) >>> 0
      if (nextHash === 0 || nextHash <= hash) break
      hash = nextHash
    }
    this.hash = hash
  }

  /** getSegmentSkip（cipher_rc4.go:119-124）：float64 除法语义与 Go 相同 */
  private getSegmentSkip(id: number): number {
    const seed = this.key[id % this.n]
    const divisor = (id + 1) * seed
    if (divisor === 0) throw new Error('qmc/rc4: 段种子为 0（密钥不匹配）')
    const idx = (this.hash / divisor) * 100
    return Math.floor(idx) % this.n
  }

  private encFirstSegment(buf: Uint8Array, offset: number): void {
    for (let i = 0; i < buf.length; i++) buf[i] ^= this.key[this.getSegmentSkip(offset + i)]
  }

  /** encASegment（cipher_rc4.go:97-115）：box 洗牌 + 偏移量预热 skipLen 步 */
  private encASegment(buf: Uint8Array, offset: number): void {
    const box = new Uint8Array(this.box)
    let j = 0
    let k = 0
    const skipLen = (offset % RC4_SEGMENT_SIZE) + this.getSegmentSkip(Math.floor(offset / RC4_SEGMENT_SIZE))
    for (let i = -skipLen; i < buf.length; i++) {
      j = (j + 1) % this.n
      k = (box[j] + k) % this.n
      const t = box[j]
      box[j] = box[k]
      box[k] = t
      if (i >= 0) buf[i] ^= box[(box[j] + box[k]) % this.n]
    }
  }

  /** Decrypt（cipher_rc4.go:66-96）：首 128 字节段 + 5120 字节段 + 尾段 */
  decrypt(src: Uint8Array, offsetIn: number): void {
    let toProcess = src.length
    let processed = 0
    let offset = offsetIn
    const markProcess = (p: number): boolean => {
      offset += p
      toProcess -= p
      processed += p
      return toProcess === 0
    }

    if (offset < RC4_FIRST_SEGMENT_SIZE) {
      let blockSize = toProcess
      if (blockSize > RC4_FIRST_SEGMENT_SIZE - offset) blockSize = RC4_FIRST_SEGMENT_SIZE - offset
      this.encFirstSegment(src.subarray(0, blockSize), offset)
      if (markProcess(blockSize)) return
    }

    if (offset % RC4_SEGMENT_SIZE !== 0) {
      let blockSize = toProcess
      if (blockSize > RC4_SEGMENT_SIZE - (offset % RC4_SEGMENT_SIZE)) {
        blockSize = RC4_SEGMENT_SIZE - (offset % RC4_SEGMENT_SIZE)
      }
      this.encASegment(src.subarray(processed, processed + blockSize), offset)
      if (markProcess(blockSize)) return
    }

    while (toProcess > RC4_SEGMENT_SIZE) {
      this.encASegment(src.subarray(processed, processed + RC4_SEGMENT_SIZE), offset)
      markProcess(RC4_SEGMENT_SIZE)
    }

    if (toProcess > 0) this.encASegment(src.subarray(processed), offset)
  }
}

// --- 选择器（qmc.go NewQmcCipherDecoder：派生密钥 >300 → RC4；非空 → map；空 → static） ---

export function createCipher(decodedKey: Uint8Array): QmcStreamCipher {
  if (decodedKey.length > 300) return new Rc4Cipher(decodedKey)
  if (decodedKey.length !== 0) return new MapCipher(decodedKey)
  return createStaticCipher()
}