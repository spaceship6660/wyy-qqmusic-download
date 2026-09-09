import { describe, it, expect, vi } from 'vitest'
import { getFavPlaylists, getUserPlaylists, getDissTracksPage } from '../src/main/qqapi/playlists'
import type { QqClient } from '../src/main/qqapi/client'

// 最小 client mock：只实现被测函数用到的 postMusicu
function mockClient(data: unknown): QqClient {
  return { postMusicu: vi.fn(async () => data) } as unknown as QqClient
}

describe('getFavPlaylists 封面兼容', () => {
  it('diss_cover 完整 URL 直用；pic_mid 按 T002 拼；旧 picUrl 照旧', async () => {
    const client = mockClient({
      v_list: [
        { dissid: 11, dissname: 'A', diss_cover: 'http://cover/a.jpg', song_cnt: 30 },
        { dissid: 22, dissname: 'B', pic_mid: 'PMID123', songnum: 10 },
        { dissid: 33, dissname: 'C', picUrl: 'https://cover/c.jpg', song_cnt: 5 },
        { dissid: 44, dissname: 'D', songnum: 7 },
      ],
    })
    const list = await getFavPlaylists(client, 'EUX')
    expect(list.length).toBe(4)
    expect(list[0].cover).toBe('http://cover/a.jpg')
    expect(list[1].cover).toBe('https://y.gtimg.cn/music/photo_new/T002R300x300M000PMID123.jpg')
    expect(list[2].cover).toBe('https://cover/c.jpg')
    expect(list[3].cover).toBe('')
    expect(list[0].trackCount).toBe(30)
  })

  it('无 euin 时 app 层直接返回空（此处只验 debug 回调收到原始 keys）', async () => {
    const client = mockClient({ v_list: [{ dissid: 1, dissname: 'X', foo_bar: 1 }] })
    const lines: string[] = []
    await getFavPlaylists(client, 'EUX', (l) => lines.push(l))
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('dissid')
    expect(lines[0]).toContain('foo_bar')
  })
})

describe('getUserPlaylists', () => {
  it('v_playlist 大写字段解析', async () => {
    const client = mockClient({
      v_playlist: [{ dirId: 201, dirName: '我喜欢', songNum: 50, picUrl: 'http://cover/like.jpg' }],
    })
    const list = await getUserPlaylists(client, '123')
    expect(list.length).toBe(1)
    expect(list[0].id).toBe('201')
    expect(list[0].cover).toBe('http://cover/like.jpg')
    expect(list[0].trackCount).toBe(50)
  })
})

describe('getDissTracksPage 分页诊断', () => {
  const song = (mid: string) => ({ mid, name: `歌${mid}`, singer: [{ name: '歌手' }], album: { name: '专辑' }, file: {}, interval: 200 })
  it('正常页：more 计算 + debug 记录 begin/条数/total', async () => {
    const client = mockClient({ songlist: [song('m1'), song('m2')], total: 500 })
    const lines: string[] = []
    const page = await getDissTracksPage(client, { dirid: 201, songBegin: 200 }, (l) => lines.push(l))
    expect(page?.tracks.length).toBe(2)
    expect(page?.total).toBe(500)
    expect(page?.more).toBe(true)
    expect(page?.nextBegin).toBe(202)
    expect(page?.totalSource).toBe('total')
    expect(lines.join('')).toContain('begin=200')
    expect(lines.join('')).toContain('raw=2')
  })
  it('无 total 兜底：拿满一页视为还有（more=true），短页视为到底', async () => {
    const full = await getDissTracksPage(mockClient({ songlist: Array.from({ length: 200 }, (_, i) => song(`m${i}`)) }), { dirid: 201, songBegin: 0 })
    expect(full?.more).toBe(true)
    expect(full?.nextBegin).toBe(200)
    expect(full?.totalSource).toBe('fallback')
    const short = await getDissTracksPage(mockClient({ songlist: [song('m1')] }), { dirid: 201, songBegin: 200 })
    expect(short?.more).toBe(false)
  })
  it('总数候选字段：total_song_num 可用；过滤掉无 mid 条目但游标按原始推进', async () => {
    const list = Array.from({ length: 200 }, (_, i) => (i === 5 ? { name: '坏条目' } : song(`m${i}`)))
    const page = await getDissTracksPage(mockClient({ songlist: list, total_song_num: 1500 }), { dirid: 201, songBegin: 0 })
    expect(page?.tracks.length).toBe(199) // 渲染数
    expect(page?.more).toBe(true) // 按原始 200 判定，不断流
    expect(page?.nextBegin).toBe(200) // 游标按原始推进，不重叠
    expect(page?.total).toBe(1500)
    expect(page?.totalSource).toBe('total_song_num')
  })
})
