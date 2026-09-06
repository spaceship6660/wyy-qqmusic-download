import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { deriveKey, simpleMakeKey } from '../src/main/unlock/derive'
import { decryptQmcFile } from '../src/main/unlock/decrypt'

const FIX = path.join(__dirname, 'fixtures', 'qmc')

function load(name: string): Buffer {
  return fs.readFileSync(path.join(FIX, name))
}

// Go qmc_test.go 的拼法：raw + suffix 拼接 = 完整加密文件
function encFile(name: string): Buffer {
  return Buffer.concat([load(`${name}_raw.bin`), load(`${name}_suffix.bin`)])
}

describe('simpleMakeKey（Go key_derive 向量）', () => {
  it('simpleMakeKey(106, 8) = 期望字节', () => {
    expect([...simpleMakeKey(106, 8)]).toEqual([0x69, 0x56, 0x46, 0x38, 0x2b, 0x20, 0x15, 0x0b])
  })
})

describe('deriveKey（Go key_derive_test 向量：key_raw → key）', () => {
  const cases: [string, string][] = [
    ['mflac0_rc4', 'mflac0_rc4_key.bin'],
    ['mflac_rc4', 'mflac_rc4_key.bin'],
    ['mflac_map', 'mflac_map_key.bin'],
    ['mgg_map', 'mgg_map_key.bin'],
  ]
  for (const [file, expectKey] of cases) {
    it(`${file}: deriveKey(key_raw) 逐字节等于 key`, () => {
      const raw = load(`${file}_key_raw.bin`)
      // 去尾 NUL（readRawKey 语义）
      let end = raw.length
      while (end > 0 && raw[end - 1] === 0) end--
      const derived = Buffer.from(deriveKey(raw.subarray(0, end)))
      const expected = load(expectKey)
      expect(derived.equals(expected)).toBe(true)
      expect(derived.length).toBe(expected.length)
    })
  }
})

describe('decryptQmcFile 端到端（Go qmc_test 向量：raw+suffix → 明文 target）', () => {
  const cases: [string, 'flac' | 'ogg' | 'mp3'][] = [
    ['mflac0_rc4', 'flac'],
    ['mflac_rc4', 'flac'],
    ['mflac_map', 'flac'],
    ['mgg_map', 'ogg'],
    ['qmc0_static', 'mp3'],
  ]
  for (const [name, ext] of cases) {
    it(`${name}: 解密结果为 ${ext} 且与 target 逐字节相等`, () => {
      const result = decryptQmcFile(encFile(name))
      const target = load(`${name}_target.bin`)
      expect(result.ext).toBe(ext)
      expect(Buffer.from(result.audio).equals(target)).toBe(true)
    })
  }

  it('QTag 结尾：构造文件解密 + songId 提取', () => {
    // 用 mflac_map 的样本构造 QTag 文件：audio(65536) || meta || BE32(metaLen) || "QTag"
    const audio = load('mflac_map_raw.bin')
    const keyRaw = load('mflac_map_key_raw.bin')
    let rawEnd = keyRaw.length
    while (rawEnd > 0 && keyRaw[rawEnd - 1] === 0) rawEnd--
    const meta = Buffer.from(`${keyRaw.subarray(0, rawEnd).toString('latin1')},12345,0`, 'latin1')
    const metaLen = Buffer.alloc(4)
    metaLen.writeUInt32BE(meta.length, 0)
    const file = Buffer.concat([audio, meta, metaLen, Buffer.from('QTag')])

    const result = decryptQmcFile(file)
    expect(result.ext).toBe('flac')
    expect(result.songId).toBe(12345)
    expect(Buffer.from(result.audio).equals(load('mflac_map_target.bin'))).toBe(true)
  })
})

describe('decryptQmcFile 错误路径', () => {
  it('musicex（"cex\\0" 结尾）→ 明确报错（无密钥）', () => {
    const f = Buffer.concat([load('qmc0_static_raw.bin'), Buffer.from('cex\0')])
    expect(() => decryptQmcFile(f)).toThrow(/musicex/)
  })

  it('STag 结尾 → 报错', () => {
    const f = Buffer.concat([load('qmc0_static_raw.bin'), Buffer.from('STag')])
    expect(() => decryptQmcFile(f)).toThrow(/STag/)
  })

  it('密钥与文件不匹配（张冠李戴）→ 容器嗅探失败', () => {
    // mflac_rc4 的密钥解 mflac_map 的文件：解密头不是合法容器
    const mapEnc = encFile('mflac_map')
    const keyRaw = load('mflac_rc4_key_raw.bin')
    let end = keyRaw.length
    while (end > 0 && keyRaw[end - 1] === 0) end--
    // 手工构造 raw-key 尾（size + key）——密钥不匹配场景
    const tail = Buffer.alloc(4)
    tail.writeUInt32LE(end, 0)
    const wrong = Buffer.concat([mapEnc.subarray(0, mapEnc.length - 4 - 368), keyRaw.subarray(0, end), tail])
    expect(() => decryptQmcFile(wrong)).toThrow(/无法识别/)
  })
})