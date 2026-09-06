// QQ 音乐加密文件解密：密钥派生（移植自 showhwa/UnlockMusicProject_Archive
// tmp/cli/algo/qmc/key_derive.go，逐字节对应）。base64 用 Node Buffer 的
// standard alphabet（与 Go base64.StdEncoding 一致，容忍缺 padding）。
// 派生逻辑：base64 解码 → 可选 "QQMusic EncV2,Key:" 前缀走 V2（TEA×2 + 再 base64）
// → V1（TEA 解密 + 前 8 字节保留）。
import { decryptTencentTea } from './tea'

const rawKeyPrefixV2 = 'QQMusic EncV2,Key:'

/** simpleMakeKey(106, 8)（key_derive.go:14-23）：期望 [0x69,0x56,0x46,0x38,0x2b,0x20,0x15,0x0b] */
export function simpleMakeKey(salt: number, length: number): Uint8Array {
  const keyBuf = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    const tmp = Math.tan(salt + i * 0.1)
    keyBuf[i] = Math.abs(tmp) * 100
  }
  return keyBuf
}

/** deriveKey（key_derive.go:35-59）：rawKey=文件尾部读出的 base64 字符串（已去尾 NUL） */
export function deriveKey(rawKey: Uint8Array): Uint8Array {
  let rawKeyDec = base64Decode(rawKey)
  if (rawKeyDec.length >= rawKeyPrefixV2.length && String.fromCharCode(...rawKeyDec.subarray(0, rawKeyPrefixV2.length)) === rawKeyPrefixV2) {
    rawKeyDec = deriveKeyV2(rawKeyDec.subarray(rawKeyPrefixV2.length))
  }
  return deriveKeyV1(rawKeyDec)
}

function deriveKeyV1(rawKeyDec: Uint8Array): Uint8Array {
  if (rawKeyDec.length < 16) throw new Error('密钥过短（少于 16 字节）')
  const simpleKey = simpleMakeKey(106, 8)
  const teaKey = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    teaKey[i << 1] = simpleKey[i]
    teaKey[(i << 1) + 1] = rawKeyDec[i]
  }
  const rs = decryptTencentTea(rawKeyDec.subarray(8), teaKey)
  const out = new Uint8Array(8 + rs.length)
  out.set(rawKeyDec.subarray(0, 8))
  out.set(rs, 8)
  return out
}

// deriveV2Key1/2（key_derive.go:64-72）
const deriveV2Key1 = new Uint8Array([
  0x33, 0x38, 0x36, 0x5a, 0x4a, 0x59, 0x21, 0x40,
  0x23, 0x2a, 0x24, 0x25, 0x5e, 0x26, 0x29, 0x28,
])
const deriveV2Key2 = new Uint8Array([
  0x2a, 0x2a, 0x23, 0x21, 0x28, 0x23, 0x24, 0x25,
  0x26, 0x5e, 0x61, 0x31, 0x63, 0x5a, 0x2c, 0x54,
])

function deriveKeyV2(raw: Uint8Array): Uint8Array {
  let buf = decryptTencentTea(raw, deriveV2Key1)
  buf = decryptTencentTea(buf, deriveV2Key2)
  return base64Decode(buf)
}

function base64Decode(src: Uint8Array): Uint8Array {
  // latin1=逐字节保真；Node base64 与 Go StdEncoding 兼容（容忍缺 padding）
  const s = Buffer.from(src.buffer, src.byteOffset, src.byteLength).toString('latin1')
  return new Uint8Array(Buffer.from(s, 'base64'))
}