import { describe, it, expect } from 'vitest'
import { parseLrcLine, formatLrcTime, mergeLyricTranslation } from '../src/main/lyricMerge'

describe('parseLrcLine', () => {
  it('解析分秒毫秒并去标签取文本', () => {
    expect(parseLrcLine('[00:16.12]夢ならば')).toEqual({ ms: 16120, text: '夢ならば' })
    expect(parseLrcLine('[01:02.345]abc')).toEqual({ ms: 62345, text: 'abc' })
    expect(parseLrcLine('[ti:标题]')).toBeNull()
    expect(parseLrcLine('[ar:歌手]')).toBeNull()
    expect(parseLrcLine('[offset:+500]')).toBeNull()
    expect(parseLrcLine('纯文本')).toBeNull()
  })
})

describe('formatLrcTime', () => {
  it('毫秒回 [mm:ss.xx]（有零头保留三位）', () => {
    expect(formatLrcTime(16120)).toBe('00:16.12')
    expect(formatLrcTime(851)).toBe('00:00.851')
    expect(formatLrcTime(62345)).toBe('01:02.345')
    expect(formatLrcTime(0)).toBe('00:00.00')
  })
})

describe('mergeLyricTranslation', () => {
  const ORIG = [
    '[ti:Lemon]',
    '[00:00.000] 作词 : 米津玄師',
    '[00:00.851]夢ならばどれほどよかったでしょう',
    '[00:06.650]未だにあなたのことを夢にみる',
    '',
  ].join('\n')
  const TRANS = [
    '[00:00.851]如果这一切都是梦境该有多好',
    '[00:06.650]至今仍能与你在梦中相遇',
  ].join('\n')

  it('译文按时间戳插入原文行下（头行/标签不动，不按行号zip）', () => {
    const got = mergeLyricTranslation(ORIG, TRANS)
    const lines = got.split('\n')
    // [ti:] 标签与作词行保持单行
    expect(lines[0]).toBe('[ti:Lemon]')
    expect(lines[1]).toBe('[00:00.000] 作词 : 米津玄師')
    // 演唱行：原文下紧跟同时间戳译文
    const i = lines.indexOf('[00:00.851]夢ならばどれほどよかったでしょう')
    expect(lines[i + 1]).toBe('[00:00.851]如果这一切都是梦境该有多好')
    const j = lines.indexOf('[00:06.650]未だにあなたのことを夢にみる')
    expect(lines[j + 1]).toBe('[00:06.650]至今仍能与你在梦中相遇')
  })

  it('译文为空/无时间戳 → 原文原样返回', () => {
    expect(mergeLyricTranslation(ORIG, '')).toBe(ORIG)
    expect(mergeLyricTranslation(ORIG, '   ')).toBe(ORIG)
    expect(mergeLyricTranslation(ORIG, '没有时间戳的译文')).toBe(ORIG)
    expect(mergeLyricTranslation('', TRANS)).toBe('')
  })

  it('600ms 内漂移退化配对（用原文时间戳），超出不配对、译文追加末尾', () => {
    const got = mergeLyricTranslation('[00:10.000]aaa', '[00:10.500]译文A\n[99:00.000]译文B')
    const lines = got.split('\n')
    expect(lines[1]).toBe('[00:10.000]译文A')
    expect(lines[lines.length - 1]).toBe('[99:00.00]译文B')
  })

  it('同一译文只用一次（重复时间戳原文各配不同行）', () => {
    const got = mergeLyricTranslation('[00:01.00]a\n[00:01.00]b', '[00:01.00]译')
    const hits = got.split('\n').filter((l) => l === '[00:01.00]译')
    expect(hits.length).toBe(1)
  })

  it('QQ 式 // 占位行丢弃（不配对、不追加）', () => {
    const got = mergeLyricTranslation(
      '[00:01.54]夢ならば\n[00:02.88]どれほど',
      '[00:00.00]//\n[00:01.54]如果只是一场梦\n[00:02.88]那该有多好',
    )
    expect(got.split('\n')).toEqual([
      '[00:01.54]夢ならば',
      '[00:01.54]如果只是一场梦',
      '[00:02.88]どれほど',
      '[00:02.88]那该有多好',
    ])
    expect(got).not.toContain('//')
  })
})
