import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createQqClient } from '../src/main/qqapi/client'
import { searchTracks, getTrackDetail, getSingleTrack, parseLink, fetchPlaylist, fetchAlbum, fetchAlbumInfo, stripJsonp, qqCoverUrl, searchAlbums, isVipEntry, describeTierSizes } from '../src/main/qqapi/tracks'

const fx = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'qqapi', name), 'utf-8')

// fetch mock：按 URL/请求体路由到 fixture 文件。
// client.postMusicu 调用 fetchImpl(API_URL, { method, headers, body, ... })，
// 即第一个参数是 URL 字符串、请求体在第二个参数 init.body 中。
function routedFetch(): typeof fetch {
  return vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('musicu.fcg')) {
      const body = JSON.parse(String(init?.body))
      if (body.req?.method === 'DoSearchForQQMusicDesktop') return new Response(fx('search.json'))
      if (body.info?.method === 'get_song_detail_yqq') return new Response(fx('detail.json'))
    }
    if (url.includes('fcg_ucc_getcdinfo_byids_cp')) return new Response(fx('playlist.json'))
    if (url.includes('fcg_v8_album_info_cp')) return new Response(fx('album.json'))
    if (url.includes('client_search_cp')) return new Response(fx('album-search.json'))
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
}

describe('搜索', () => {
  it('解析成 TrackDTO（多歌手合并/封面/VIP 字段）', async () => {
    const client = createQqClient(routedFetch(), { uin: '0' })
    const tracks = await searchTracks(client, '天空之城', { limit: 10 })
    expect(tracks.length).toBeGreaterThan(0)
    const t = tracks[0]
    expect(t.id).toBeTruthy()
    expect(t.artist).toBeTypeOf('string')
    expect(t.cover).toContain('http')
    expect(tracks[1].artist).toBe('南征北战NZBZ / 白勺啊白')
    expect(tracks[0].vip).toBe(false) // fixture 无 try_begin / pay.pay_down → 非 VIP
    expect(tracks[0].duration).toBeTypeOf('number')
    expect(tracks[3].artist).toBe('未知歌手')
  })
})

describe('VIP/付费判定（isVipEntry）', () => {
  it('pay.pay_down>0 判 VIP（歌单/我喜欢条目的主要依据）', () => {
    // 2026-09-27 实测：CgiGetDiss 的 songlist 条目带完整 pay 对象
    expect(isVipEntry({ pay: { pay_down: 1, pay_month: 1, price_track: 0 } })).toBe(true)
    expect(isVipEntry({ pay: { pay_down: 0, pay_month: 0 } })).toBe(false)
  })

  it('song detail 的 flags.try_begin>0 判 VIP', () => {
    expect(isVipEntry({ flags: { try_begin: 1 } })).toBe(true)
    expect(isVipEntry({ flags: { try_begin: 0 } })).toBe(false)
  })

  it('file.try_begin 不参与判定（免费曲也带它 → 曾会把免费曲误报成会员歌）', () => {
    // 回归锚：实测《我无法用我的语言》pay 全 0、只登记 128k/m4a，却带 file.try_begin=95604
    expect(isVipEntry({ file: { try_begin: 95604 }, pay: { pay_down: 0 } })).toBe(false)
  })

  it('字段缺失/非法一律 false（不误报）', () => {
    expect(isVipEntry({})).toBe(false)
    expect(isVipEntry(undefined)).toBe(false)
    expect(isVipEntry({ file: {}, pay: {} })).toBe(false)
    expect(isVipEntry({ flags: { try_begin: 'x' } })).toBe(false)
  })
})

describe('档位回显（describeTierSizes）', () => {
  it('只列体积 > 0 的档位，按高→低', () => {
    expect(describeTierSizes({ flac: 100, ape: 0, mp3_320: 0, mp3_128: 4459842, m4a: 3403915 }))
      .toBe('无损 FLAC / 128k / m4a')
  })

  it('全为 0 / 缺失 → 空串（调用方据此显示「无」）', () => {
    expect(describeTierSizes({ flac: 0, ape: 0, mp3_320: 0, mp3_128: 0, m4a: 0 })).toBe('')
    expect(describeTierSizes(undefined)).toBe('')
  })
})

describe('单曲详情', () => {
  it('拿 mediaMid/发行时间/VIP 判定', async () => {
    const client = createQqClient(routedFetch(), { uin: '0' })
    const d = await getTrackDetail(client, '000TEST')
    expect(d.mediaMid).toBeTruthy()
    expect(typeof d.date).toBe('string')
    expect(typeof d.vip).toBe('boolean')
    expect(d.sizes.flac).toBe(123)
    expect(d.vip).toBe(true)
    expect(d.date).toBe('2020-05-01')
  })
})

describe('单曲链接', () => {
  it('getSingleTrack 组装 TrackDTO', async () => {
    const client = createQqClient(routedFetch(), { uin: '0' })
    const t = await getSingleTrack(client, '004Ti8rT003TaZ')
    expect(t.id).toBe('004Ti8rT003TaZ')
    expect(t.name).toBeTruthy()
    expect(t.mediaMid).toBeTruthy()
    expect(t.vip).toBe(true)
  })
})

describe('链接解析', () => {
  it('识别 songDetail/playlist/album 三种链接', () => {
    expect(parseLink('https://y.qq.com/n/ryqq/songDetail/004Ti8rT003TaZ')).toEqual({ kind: 'song', id: '004Ti8rT003TaZ' })
    expect(parseLink('https://y.qq.com/n/ryqq/playlist/1374105607')).toEqual({ kind: 'playlist', id: '1374105607' })
    expect(parseLink('https://y.qq.com/n/ryqq/albumDetail/000gXCTb2AhRR1')).toEqual({ kind: 'album', id: '000gXCTb2AhRR1' })
    expect(parseLink('随便一句话')).toBeNull()
  })
  it('hostname 校验：伪造 host 或任意文本内嵌链接不误判', () => {
    expect(parseLink('https://evily.qq.com/n/ryqq/songDetail/ABC')).toBeNull()
    expect(parseLink('https://evil.example/?u=https://y.qq.com/n/ryqq/songDetail/ABC')).toBeNull()
    expect(parseLink('y.qq.com/n/ryqq/playlist/123')).toEqual({ kind: 'playlist', id: '123' }) // 缺协议补 https
  })
})

describe('stripJsonp', () => {
  it('剥离 JSONP 包裹，普通 JSON 原样返回', () => {
    expect(stripJsonp('MusicJsonCallback({});')).toBe('{}')
    expect(stripJsonp('{"a":1}')).toBe('{"a":1}')
  })
  it('多行 JSONP 回调体也可剥离（`.` 不匹配换行，此前会残留包裹导致 JSON.parse 抛错）', () => {
    const wrapped = 'MusicJsonCallback({\n  "a": 1\n});'
    expect(stripJsonp(wrapped)).toBe('{\n  "a": 1\n}')
    expect(JSON.parse(stripJsonp(wrapped))).toEqual({ a: 1 })
  })
})

describe('歌单/专辑', () => {
  it('专辑搜索 client_search_cp 真实结构解析（albumPic 完整 URL 直用）', async () => {
    const client = createQqClient(routedFetch(), { uin: '0' })
    const albums = await searchAlbums(client, '稻香')
    expect(albums.length).toBe(2)
    expect(albums[0].mid).toBe('002Neh8l0uciQZ')
    expect(albums[0].name).toBe('魔杰座')
    expect(albums[0].singer).toBe('周杰伦')
    expect(albums[0].cover).toBe('http://y.gtimg.cn/music/photo_new/T002R180x180M000002Neh8l0uciQZ_3.jpg')
    expect(albums[0].songCount).toBe(11)
    // singer_list 为空回退 singerName；albumPic 为空则封面空串（不拼垃圾 URL）
    expect(albums[1].singer).toBe('测试歌手')
    expect(albums[1].cover).toBe('')
  })
  it('歌单去 JSONP 包裹并取 songlist', async () => {
    const client = createQqClient(routedFetch(), { uin: '0' })
    const entries = await fetchPlaylist(client, '1374105607')
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0].id).toBeTruthy()
  })
  it('专辑取 list', async () => {
    const client = createQqClient(routedFetch(), { uin: '0' })
    const entries = await fetchAlbum(client, '000gXCTb2AhRR1')
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0].album).toBeTruthy()
  })
})
describe('qqCoverUrl（2026-09-06：搜索响应只有 pmid）', () => {
  it('pmid 拼标准封面 URL；picUrl 优先；都没有则空串', () => {
    expect(qqCoverUrl({ album: { pmid: '002dgkGb2BeT3R_2' } })).toBe('https://y.gtimg.cn/music/photo_new/T002R300x300M000002dgkGb2BeT3R_2.jpg')
    expect(qqCoverUrl({ album: { pmid: 'X', picUrl: 'http://a/b.jpg' } })).toBe('http://a/b.jpg')
    expect(qqCoverUrl({ album: {} })).toBe('')
  })
})

// mock client：URL → 响应文本。专辑元数据用例逐例自带数据（fixture 的 album.json 只有 name/list 两键，
// 接不出 aDate/company/mid 这些专辑级字段）。
function mockAlbumClient(handler: (url: string) => string) {
  return createQqClient((async (input: any) => {
    return new Response(handler(String(input)), { status: 200 })
  }) as unknown as typeof fetch, { uin: '0' })
}

describe('fetchAlbumInfo（0.7.0 专辑封装）', () => {
  it('返回 { bundle, tracks }，元数据不再被丢弃', async () => {
    const raw = JSON.stringify({ code: 0, data: {
      name: '奇爱人生 LOVE ELEGIA', singername: '阿良良木健', aDate: '2019-05-20',
      company: '未确定', mid: '002xyz', total_song_num: 21,
      list: [{ songmid: 'S1', songname: '告别曲', albummid: '002xyz', singer: [{ name: '阿良良木健' }], cdIdx: 1 }],
    } })
    const client = mockAlbumClient(() => raw)
    const r = await fetchAlbumInfo(client, '002xyz')
    expect(r.bundle).toMatchObject({ source: 'qq', id: '002xyz', name: '奇爱人生 LOVE ELEGIA', totalTracks: 1 })
    expect(r.tracks[0].trackNo).toBe(1)
  })

  it('请求 URL 必须带 .fcg 后缀（漏了得 404，被 client 误报成风控）', async () => {
    const urls: string[] = []
    await fetchAlbumInfo(mockAlbumClient((u: string) => { urls.push(u); return '{"data":{"list":[]}}' }), 'm1')
    expect(urls[0]).toContain('fcg_v8_album_info_cp.fcg')
  })

  it('专辑级字段全部接出：date/company/coverUrl/discs（coverUrl 用 R500 大图，2026-10-07 冒烟验 200+JPEG）', async () => {
    const raw = JSON.stringify({ code: 0, data: {
      name: '奇爱人生 LOVE ELEGIA', singername: '阿良良木健', aDate: '2019-05-20', company: '某某唱片',
      mid: '002xyz', singermid: '001abc',
      list: [
        { songmid: 'S1', songname: '告别曲', albummid: '002xyz', singer: [{ name: '阿良良木健' }], cdIdx: 1 },
        { songmid: 'S2', songname: '遗忘山丘', albummid: '002xyz', singer: [{ name: '阿良良木健' }], cdIdx: 2 },
      ],
    } })
    const r = await fetchAlbumInfo(mockAlbumClient(() => raw), '002xyz')
    expect(r.bundle.date).toBe('2019-05-20')
    expect(r.bundle.company).toBe('某某唱片')
    expect(r.bundle.artist).toBe('阿良良木健')
    expect(r.bundle.coverUrl).toBe('https://y.gtimg.cn/music/photo_new/T002R500x500M000002xyz.jpg')
    expect(r.bundle.discs).toEqual([1, 2])
    expect(r.tracks.map((x) => x.disc)).toEqual([1, 2])
    // discTotals：cue 完成度按这张专辑的真实每碟曲目数判，不是按用户入队了几首
    expect(r.bundle.discTotals).toEqual({ 1: 1, 2: 1 })
  })

  it('totalTracks 用 list 实长，不信 total_song_num（实测同一张专辑 21 vs 22）', async () => {
    const list = Array.from({ length: 3 }, (_, i) => ({ songmid: `S${i}`, songname: `曲${i}`, albummid: '002m' }))
    const raw = JSON.stringify({ code: 0, data: { name: 'A', mid: '002m', total_song_num: 2, list } })
    const r = await fetchAlbumInfo(mockAlbumClient(() => raw), '002m')
    expect(r.tracks.length).toBe(3)
    expect(r.bundle.totalTracks).toBe(3)
  })

  it('list 缺失 / 为空 → tracks: [] 且 totalTracks: 0（空专辑要让调用方认得出来，不能抛）', async () => {
    for (const body of ['{"data":{}}', '{"data":{"name":"空"} }', '{"code":0}', '{}', '{"data":{"list":[]}}', '{"data":{"list":null}}']) {
      const r = await fetchAlbumInfo(mockAlbumClient(() => body), 'm-empty')
      expect(r.tracks).toEqual([])
      expect(r.bundle.totalTracks).toBe(0)
      expect(r.bundle.discs).toEqual([1])
    }
  })

  it('cdIdx 缺失/为 0 → 单碟 1（认不出就退化，不凭空造碟号）', async () => {
    const raw = JSON.stringify({ data: { name: 'A', mid: '002m', list: [
      { songmid: 'S1', songname: '一', albummid: '002m' },
      { songmid: 'S2', songname: '二', albummid: '002m', cdIdx: 0 },
    ] } })
    const r = await fetchAlbumInfo(mockAlbumClient(() => raw), '002m')
    expect(r.tracks.map((x) => x.disc)).toEqual([1, 1])
    expect(r.bundle.discs).toEqual([1])
    // 单碟专辑：discTotals[1] 就是整张的曲目数（整张下载的主路径靠这个数判 cue）
    expect(r.bundle.discTotals).toEqual({ 1: 2 })
  })

  it('list 有 10 首 → discTotals {1:10}（解析层看到的是整张，页面却只把前 2 首交给用户）', async () => {
    // 2026-10-07 评审的洞就在这里：专辑页懒加载，完成度若按入队曲目数判，
    // 只入队 2 首也会写出 2 FILE 的 cue。真实曲目数只有这里看得到，必须接进 bundle。
    const list = Array.from({ length: 10 }, (_, i) => ({
      songmid: `S${i}`, songname: `曲${i}`, albummid: '002m', cdIdx: 1,
    }))
    const r = await fetchAlbumInfo(mockAlbumClient(() => JSON.stringify({ data: { name: 'A', mid: '002m', list } })), '002m')
    expect(r.bundle.totalTracks).toBe(10)
    expect(r.bundle.discTotals).toEqual({ 1: 10 })
  })

  it('序号取数组下标 +1（服务端无序号字段，实测条目只有 belongCD/cdIdx）', async () => {
    const raw = JSON.stringify({ data: { name: 'A', mid: '002m', list: [
      { songmid: 'S1', albummid: '002m' }, { songmid: 'S2', albummid: '002m' }, { songmid: 'S3', albummid: '002m' },
    ] } })
    const r = await fetchAlbumInfo(mockAlbumClient(() => raw), '002m')
    expect(r.tracks.map((x) => x.trackNo)).toEqual([1, 2, 3])
  })

  it('VIP 判定复用 isVipEntry：pay.pay_down>0 即 vip，file.try_begin 仍不参与', async () => {
    // 回归锚：专辑解析若自己写一份判据（常见错误是拿 file.try_begin 判），免费曲会被打成会员歌
    const raw = JSON.stringify({ data: { name: 'A', mid: '002m', list: [
      { songmid: 'S1', albummid: '002m', pay: { pay_down: 1, pay_month: 1 } },
      { songmid: 'S2', albummid: '002m', pay: { pay_down: 0 }, file: { try_begin: 95604 } },
      { songmid: 'S3', albummid: '002m', flags: { try_begin: 1 } },
    ] } })
    const r = await fetchAlbumInfo(mockAlbumClient(() => raw), '002m')
    expect(r.tracks.map((x) => x.vip)).toEqual([true, false, true])
  })

  it('曲目映射逐字段仍由 trackFromEntry 产出（spread 只加 trackNo/disc，不改写既有字段）', async () => {
    const raw = JSON.stringify({ data: {
      name: '专辑名（缺 albumname 时的兜底）', mid: '002xyz',
      list: [{
        songmid: 'S1', songname: '告别曲', albumname: '真实专辑名', albummid: '002xyz',
        singer: [{ name: '阿良良木健' }, { name: '某某' }], media_mid: 'MM1', interval: 300,
      }],
    } })
    const r = await fetchAlbumInfo(mockAlbumClient(() => raw), '002xyz')
    expect(r.tracks[0]).toEqual({
      id: 'S1',
      name: '告别曲',
      artist: '阿良良木健 / 某某',
      album: '真实专辑名',
      cover: 'https://y.gtimg.cn/music/photo_new/T002R300x300M000002xyz.jpg',
      mediaMid: 'MM1',
      vip: false,
      trackNo: 1,
      disc: 1,
    })
    // 无 albumname 的条目仍走 data.name 兜底（trackFromEntry 的第二个参数不能丢）
    const r2 = await fetchAlbumInfo(mockAlbumClient(() => JSON.stringify({
      data: { name: '兜底专辑', mid: '002xyz', list: [{ songmid: 'S1', albummid: '' }] },
    })), '002xyz')
    expect(r2.tracks[0].album).toBe('兜底专辑')
    expect(r2.tracks[0].cover).toBe('')
  })

  it('data.mid 缺失 → coverUrl 空串（拼不出就不写 cover.jpg，不出垃圾 URL）', async () => {
    const r = await fetchAlbumInfo(mockAlbumClient(() => JSON.stringify({
      data: { name: 'A', singermid: '001a', list: [{ songmid: 'S1', albummid: '002m' }] },
    })), '002m')
    expect(r.bundle.id).toBe('')
    expect(r.bundle.coverUrl).toBe('')
    expect(r.bundle.name).toBe('A')
  })

  it('JSONP 包裹照旧剥离（fcg 端点带 json=1 时可能回回调壳）', async () => {
    const body = 'MusicJsonCallback(' + JSON.stringify({ data: { name: 'A', mid: '002m', list: [{ songmid: 'S1', albummid: '002m' }] } }) + ');'
    const r = await fetchAlbumInfo(mockAlbumClient(() => body), '002m')
    expect(r.tracks.length).toBe(1)
  })

  it('fetchAlbum 兼容壳仍只回 TrackDTO[]（Task 8 之前其他调用点照旧用）', async () => {
    const raw = JSON.stringify({ data: { name: 'A', mid: '002m', list: [
      { songmid: 'S1', songname: '一', albummid: '002m' }, { songmid: 'S2', songname: '二', albummid: '002m' },
    ] } })
    const tracks = await fetchAlbum(mockAlbumClient(() => raw), '002m')
    expect(Array.isArray(tracks)).toBe(true)
    expect(tracks.length).toBe(2)
    expect(tracks[0].name).toBe('一')
    expect(tracks[0].trackNo).toBe(1) // 壳复用同一解析，序号顺带带上（旧调用点不读它）
  })

  it('既有 fixture 路径（无专辑级字段）不因新解析而回归', async () => {
    const client = createQqClient(routedFetch(), { uin: '0' })
    const r = await fetchAlbumInfo(client, '000gXCTb2AhRR1')
    expect(r.tracks.length).toBe(2)
    expect(r.tracks[0].album).toBe('天空之城印象集')
    expect(r.bundle.name).toBe('专辑名')
    expect(r.bundle.totalTracks).toBe(2)
  })
})
