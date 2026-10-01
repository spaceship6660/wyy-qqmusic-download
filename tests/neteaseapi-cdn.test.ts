import { describe, it, expect } from 'vitest'
import { NE_CDN_NODES, isNeteaseCdnUrl, cdnFallbackUrls } from '../src/main/neteaseapi/cdn'

// 2026-10-01 实机故障的规则锚：账号态直链落在 m704/m804 时恒定 403，
// 同一串 URL（含 authSecret 签名）换到 m701/m801/m802 立即 206。

describe('NE_CDN_NODES', () => {
  it('备用表不得包含实测恒 403 的 m704/m804（否则换节点等于白换）', () => {
    expect(NE_CDN_NODES).not.toContain('m704.music.126.net')
    expect(NE_CDN_NODES).not.toContain('m804.music.126.net')
    expect(NE_CDN_NODES).toEqual(['m701.music.126.net', 'm801.music.126.net', 'm802.music.126.net'])
  })
})

describe('isNeteaseCdnUrl', () => {
  it('只认 mNNN.music.126.net 精确主机名', () => {
    expect(isNeteaseCdnUrl('http://m804.music.126.net/a.flac?x=1')).toBe(true)
    expect(isNeteaseCdnUrl('https://m701.music.126.net/a.mp3')).toBe(true)
  })

  it('后缀伪造 / 其他域 / 本地端点一律 false', () => {
    expect(isNeteaseCdnUrl('http://m804.music.126.net.evil.com/a.flac')).toBe(false)
    expect(isNeteaseCdnUrl('http://m804.music.163.com/a.flac')).toBe(false)
    expect(isNeteaseCdnUrl('http://127.0.0.1:8080/ne.mp3')).toBe(false)
    expect(isNeteaseCdnUrl('not a url')).toBe(false)
  })
})

describe('cdnFallbackUrls', () => {
  const AUTH_URL = 'http://m804.music.126.net/20261001212312/c9e8be8a3c238913912b2bcc/1.flac?authSecret=abc123&cdntag=1&vuutv=x'

  it('m804 直链 → 逐个换节点，路径与查询串（含 authSecret 签名）原样保留', () => {
    const alts = cdnFallbackUrls(AUTH_URL)
    expect(alts.length).toBe(NE_CDN_NODES.length)
    for (const [i, alt] of alts.entries()) {
      const u = new URL(alt)
      expect(u.host).toBe(NE_CDN_NODES[i])
      expect(u.pathname).toBe(new URL(AUTH_URL).pathname)
      // 签名参数必须一字不改：实测换 host 后服务端不校验 host，但校验签名本身
      expect(u.searchParams.get('authSecret')).toBe('abc123')
      expect(u.searchParams.get('cdntag')).toBe('1')
      expect(u.searchParams.get('vuutv')).toBe('x')
    }
  })

  it('已在备用节点上 → 候选里不再包含自己（避免同节点重试一次）', () => {
    const alts = cdnFallbackUrls('http://m701.music.126.net/x.mp3?a=1')
    expect(alts.some((u) => new URL(u).host === 'm701.music.126.net')).toBe(false)
    expect(alts.length).toBe(NE_CDN_NODES.length - 1)
  })

  it('非网易云 CDN 主机名 → 回空（不猜、不乱换域；本地端点/QQ 直链不受影响）', () => {
    expect(cdnFallbackUrls('http://127.0.0.1:38123/ne.mp3')).toEqual([])
    expect(cdnFallbackUrls('http://m804.music.126.net.evil.com/a.flac')).toEqual([])
    expect(cdnFallbackUrls('', NE_CDN_NODES)).toEqual([])
  })

  it('节点表可覆盖（网易云轮换节点时不改码即可调整）', () => {
    const alts = cdnFallbackUrls(AUTH_URL, ['m999.music.126.net'])
    expect(alts.length).toBe(1)
    expect(new URL(alts[0]).host).toBe('m999.music.126.net')
  })
})
