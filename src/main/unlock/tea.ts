// QQ 音乐加密文件解密：TencentTEA 密钥派生用 TEA（移植自 showhwa/UnlockMusicProject_Archive
// tmp/cli/algo/qmc/key_derive.go:90-160；TEA 块密码本体对应 golang.org/x/crypto/tea 的
// NewCipherWithRounds(key, 32) 标准 32 轮实现）。
// 注意：文件体解密不走 TEA，TEA 只用于派生密钥（deriveKey V1/V2）。
import { readUInt32BE, writeUInt32BE } from './bytes'

/**
 * 标准 TEA 解密一块（8 字节，大端 uint32，delta=0x9e3779b9）。
 * 对应 golang.org/x/crypto/tea（cipher.go Decrypt）：注意其 rounds 是「半轮」计数，
 * 循环体只执行 rounds/2 次（NewCipherWithRounds(key, 32) → 16 次迭代）。
 * JS 位运算说明：Go 的 uint32 加法溢出在 JS 里靠 >>> 0 回绕；中间值最大约
 * 2^31+255，float64 精确表示，^ 运算的 ToInt32 语义与 Go uint32 位模式一致。
 */
export function teaDecryptBlock(
  src: Uint8Array,
  srcOff: number,
  key: Uint8Array,
  keyOff: number,
  dst: Uint8Array,
  dstOff: number,
  rounds = 32,
): void {
  let v0 = readUInt32BE(src, srcOff)
  let v1 = readUInt32BE(src, srcOff + 4)
  const k0 = readUInt32BE(key, keyOff)
  const k1 = readUInt32BE(key, keyOff + 4)
  const k2 = readUInt32BE(key, keyOff + 8)
  const k3 = readUInt32BE(key, keyOff + 12)
  const delta = 0x9e3779b9
  let sum = Math.imul(delta, rounds / 2) >>> 0 // delta*(rounds/2)，Go uint32 回绕
  for (let i = 0; i < rounds / 2; i++) {
    v1 = (v1 - ((((v0 << 4) + k2) ^ (v0 + sum) ^ ((v0 >>> 5) + k3)) >>> 0)) >>> 0
    v0 = (v0 - ((((v1 << 4) + k0) ^ (v1 + sum) ^ ((v1 >>> 5) + k1)) >>> 0)) >>> 0
    sum = (sum - delta) >>> 0
  }
  writeUInt32BE(dst, dstOff, v0)
  writeUInt32BE(dst, dstOff + 4, v1)
}

/**
 * TencentTEA 解密（key_derive.go decryptTencentTea 逐字节移植）：
 * CBC 变体 —— 每块先 XOR 上一密文块再解密，输出再 XOR 上一密文块（ivPrev）；
 * 起始跳过 1+padLen 字节（padLen = 首块解密后首字节 & 0x7），末尾 7 字节零校验。
 */
export function decryptTencentTea(inBuf: Uint8Array, key: Uint8Array): Uint8Array {
  const saltLen = 2
  const zeroLen = 7
  if (inBuf.length % 8 !== 0) throw new Error('TencentTEA 输入长度不是块大小倍数')
  if (inBuf.length < 16) throw new Error('TencentTEA 输入过短')

  const destBuf = new Uint8Array(8)
  teaDecryptBlock(inBuf, 0, key, 0, destBuf, 0)
  const padLen = destBuf[0] & 0x7
  const outLen = inBuf.length - 1 - padLen - saltLen - zeroLen
  if (outLen < 0) throw new Error('TencentTEA 输出长度为负（密钥不匹配）')

  const out = new Uint8Array(outLen)
  let ivPrev: Uint8Array = new Uint8Array(8) // 全零：CBC 首块只 XOR 自身密文
  let ivCur = inBuf.subarray(0, 8)
  let inBufPos = 8
  let destIdx = 1 + padLen

  const cryptBlock = (): void => {
    ivPrev = ivCur
    ivCur = inBuf.subarray(inBufPos, inBufPos + 8)
    for (let i = 0; i < 8; i++) destBuf[i] ^= inBuf[inBufPos + i]
    teaDecryptBlock(destBuf, 0, key, 0, destBuf, 0)
    inBufPos += 8
    destIdx = 0
  }

  for (let i = 1; i <= saltLen; ) {
    if (destIdx < 8) {
      destIdx++
      i++
    } else if (destIdx === 8) {
      cryptBlock()
    }
  }

  let outPos = 0
  while (outPos < outLen) {
    if (destIdx < 8) {
      out[outPos] = destBuf[destIdx] ^ ivPrev[destIdx]
      destIdx++
      outPos++
    } else if (destIdx === 8) {
      cryptBlock()
    }
  }

  for (let i = 1; i <= zeroLen; i++) {
    if (destBuf[destIdx] !== ivPrev[destIdx]) throw new Error('TencentTEA 零校验失败（密钥不匹配）')
  }

  return out
}