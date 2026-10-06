import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDownloadStore, albumPartialConfirm, albumEnqueuedNotice } from '../src/renderer/src/stores/download'
import type { UiAlbumBundle, UiTrack, UiQuality } from '../src/renderer/src/stores/download'
import { isQualityFor, labelForQuality, qualitiesFor } from '../src/renderer/src/qualityOptions'
// 跨边界只取纯 .ts 常量：vitest 是 node 环境，主进程的档位表能在测试里直接对照
import { QUALITY_LADDER } from '../src/main/qqapi/urls'
import { NE_LADDER } from '../src/main/neteaseapi/urls'
import { DEFAULT_SETTINGS, isValidQuality } from '../src/main/settings'
import type { AlbumBundle } from '../src/main/albumBundle'
import type { Quality as MainQuality, TrackDTO as MainTrackDTO } from '../src/main/qqapi/tracks'

/** 类型层同集断言：两侧并集不再互相包含 → 编译期 false → 赋值即 tsc 红灯 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

describe('download store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('勾选/全选/清空/当前质量', () => {
    const s = useDownloadStore()
    s.setTracks([
      { id: 'a', name: 'A', artist: 'X', album: '', cover: '', vip: true },
      { id: 'b', name: 'B', artist: 'Y', album: '', cover: '' },
    ])
    expect(s.selectedIds.size).toBe(0)
    s.toggle('a'); expect(s.selectedIds.has('a')).toBe(true)
    s.selectAll(); expect(s.selectedIds.size).toBe(2)
    s.clear(); expect(s.selectedIds.size).toBe(0)
    expect(s.quality).toBe('320')
    s.setQuality('flac'); expect(s.quality).toBe('flac')
  })

  it('setQuality 联动契约：码率单一事实源（store 侧）', () => {
    const s = useDownloadStore()
    expect(s.quality).toBe('320')
    s.setQuality('flac')
    expect(s.quality).toBe('flac')
  })

  it('专辑曲目经 store 原样回传：trackNo/disc 不在渲染侧丢掉', () => {
    // 勾选/整张入队时 tracks 要从这里原样回给 dl:enqueue；UiTrack 少声明字段的话这个字面量在 tsc
    // 就编译不过（丢字段的产物是 N 个 '01 曲名' 撞名，Task 10 才看得见）。
    const s = useDownloadStore()
    s.setTracks([
      { id: 'a', name: 'A', artist: 'X', album: 'B', cover: '', trackNo: 1, disc: 1 },
      { id: 'b', name: 'B', artist: 'X', album: 'B', cover: '', trackNo: 2, disc: 2 },
    ])
    expect(s.tracks.map((t) => [t.trackNo, t.disc])).toEqual([[1, 1], [2, 2]])
  })
  it('队列事件镜像：jobStart/progress/done/failed 更新 queue 列表', () => {
    const s = useDownloadStore()
    s.onQueueEvent({ id: 'j1', source: 'qq', state: 'running', progress: 10 } as any)
    expect(s.queue[0].state).toBe('running')
    s.onQueueEvent({ id: 'j1', source: 'qq', state: 'done', progress: 100, outputPath: '/x.mp3' } as any)
    expect(s.queue[0].state).toBe('done')
  })

  it('重排队移到队尾：failed → queued 不再原地更新（显示顺序=实际执行顺序）', () => {
    const s = useDownloadStore()
    const ev = (id: string, state: string) => ({ id, source: 'netease', state, progress: 0, track: { name: id } }) as any
    s.onQueueEvent(ev('a4', 'queued'))
    s.onQueueEvent(ev('a2', 'queued'))
    s.onQueueEvent({ ...ev('a4', 'running'), progress: 10 })
    s.onQueueEvent({ ...ev('a4', 'failed'), error: 'HTTP 403' })
    expect(s.queue.map((j) => j.id)).toEqual(['a4', 'a2'])
    // 重试：主进程把 a4 追加到队尾 → 渲染侧同样移到队尾
    s.onQueueEvent(ev('a4', 'queued'))
    expect(s.queue.map((j) => j.id)).toEqual(['a2', 'a4'])
    expect(s.queue[1].state).toBe('queued')
    expect(s.queue[1].error).toBeUndefined() // 新快照覆盖旧错误
    // 进行中更新仍原地（不跳动）
    s.onQueueEvent({ ...ev('a4', 'running'), progress: 50 })
    expect(s.queue.map((j) => j.id)).toEqual(['a2', 'a4'])
    expect(s.queue[1].progress).toBe(50)
  })

  it('netease source 的队列事件镜像', () => {
    const s = useDownloadStore()
    s.onQueueEvent({ id: 'n1', source: 'netease', state: 'running', progress: 0, track: { name: 'N', artist: 'A' } })
    expect(s.queue[0].source).toBe('netease')
    expect(s.queue[0].name).toBe('N')
  })

  it('歌词模式默认 both，setLyricMode 生效（下载时选择契约）', () => {
    const s = useDownloadStore()
    expect(s.lyricMode).toBe('both')
    s.setLyricMode('lrc')
    expect(s.lyricMode).toBe('lrc')
    s.setLyricMode('none')
    expect(s.lyricMode).toBe('none')
  })
})
describe('网易云选中集（窗口底部工具栏共用）', () => {
  it('neToggle/neSelectAll/neClear 与 QQ 选中集互不影响', () => {
    const s = useDownloadStore()
    s.setTracks([{ id: 'q1', name: 'Q' } as any])
    s.toggle('q1')
    s.neSelectAll([{ id: 'n1' }, { id: 'n2' }])
    s.neToggle('n2')
    expect([...s.selectedIds]).toEqual(['q1'])
    expect([...s.neSelectedIds]).toEqual(['n1'])
    s.neClear()
    expect(s.neSelectedIds.size).toBe(0)
    expect(s.selectedIds.size).toBe(1) // QQ 选中不受影响
  })
})

describe('码率档位按源过滤（DownloadOptions 的规则层，纯函数）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('网易云只有 flac/320/128，QQ 五档全开', () => {
    expect(qualitiesFor('netease').map((q) => q.v)).toEqual(['flac', '320', '128'])
    expect(qualitiesFor('netease').map((q) => q.label)).toEqual(['无损', '320k', '128k'])
    expect(qualitiesFor('qq').map((q) => q.v)).toEqual(['flac', 'ape', '320', '128', 'm4a'])
  })

  it('isQualityFor：APE/m4a 对网易云不成立，对 QQ 成立', () => {
    expect(isQualityFor('netease', 'ape')).toBe(false)
    expect(isQualityFor('netease', 'm4a')).toBe(false)
    expect(isQualityFor('netease', 'flac')).toBe(true)
    expect(isQualityFor('netease', '320')).toBe(true)
    expect(isQualityFor('netease', '128')).toBe(true)
    expect(isQualityFor('qq', 'ape')).toBe(true)
    expect(isQualityFor('qq', 'm4a')).toBe(true)
  })

  it('回落判定：网易云需要修正的只有 QQ 独有的 ape/m4a', () => {
    // settings.json 的 quality 是两个源共用的一份，QQ 侧选过 ape 后切到网易云会带着它进下载管线
    expect(qualitiesFor('qq').map((q) => q.v).filter((v) => !isQualityFor('netease', v))).toEqual(['ape', 'm4a'])
    expect(isQualityFor('qq', 'ape')).toBe(true) // QQ 侧 ape 合法，回落不能把它改掉
    // 回落写死字面 flac：两个源都提供它，所以一次回落就落在本源可见档内，watch 不再触发第二次
    expect(isQualityFor('netease', 'flac')).toBe(true)
    expect(isQualityFor('qq', 'flac')).toBe(true)
  })

  it('回落写回 store 后当前档一定落在本源可见档内（组件 watch 的等价断言）', () => {
    const s = useDownloadStore()
    s.setQuality('ape')
    const next = isQualityFor('netease', s.quality) ? s.quality : 'flac'
    s.setQuality(next)
    expect(s.quality).toBe('flac')
    expect(qualitiesFor('netease').some((x) => x.v === s.quality)).toBe(true)
    expect(isQualityFor('netease', s.quality)).toBe(true)
  })
})

describe('labelForQuality（降级提示回显实际落档）', () => {
  // WHY 落在 renderer-store.test.ts：档位中文名的唯一事实源是 qualityOptions 的 QQ_QUALITIES（五档超集），
  // 主进程没有消费方（QQ 侧报错走 describeTierSizes，回答的是「该曲登记了哪些档」，另一个问题），
  // 所以不再另立 qualityLabel/QUALITY_CN，避免第四份会漂移的词表。
  it('五档全解析（与选择器同一张表，不是第二份字面量）', () => {
    expect(labelForQuality('flac')).toBe('无损')
    expect(labelForQuality('ape')).toBe('APE')
    expect(labelForQuality('320')).toBe('320k')
    expect(labelForQuality('128')).toBe('128k')
    expect(labelForQuality('m4a')).toBe('m4a')
  })

  it('缺档名/未识别值回落「低品质」：绝不渲染出 undefined', () => {
    // 回落选「低品质」而不是原样回显：那是 0.7.0 之前的整句文案，未知档位下退化成旧行为即可，
    // 不能把内部枚举名（或 IPC 传丢的 undefined）直接甩给用户。
    expect(labelForQuality(undefined)).toBe('低品质')
    expect(labelForQuality('')).toBe('低品质')
    expect(labelForQuality('rs350')).toBe('低品质')
    // 模板拼接的等价断言：整句里不出现 "undefined"
    expect(`已降级为 ${labelForQuality(undefined)}`).toBe('已降级为 低品质')
  })

  it('队列事件把 finalQuality 透传到 UI 快照（降级行才有内容可回显）', () => {
    const s = useDownloadStore()
    s.onQueueEvent({ id: 'd1', source: 'qq', state: 'done', progress: 100, downgraded: true, finalQuality: '320', track: { name: 'D' } } as any)
    expect(s.queue[0].downgraded).toBe(true)
    expect(labelForQuality(s.queue[0].finalQuality)).toBe('320k')
    // 未走完直链解析（如 queued 快照）时 finalQuality 缺省，不报错
    s.onQueueEvent({ id: 'd2', source: 'qq', state: 'queued', progress: 0 } as any)
    expect(s.queue[1].finalQuality).toBeUndefined()
  })
})

// 跨层档位守卫（2026-10-07 评审）：选择器词表（renderer/qualityOptions）与主进程降级链
// （qqapi/urls 的 QUALITY_LADDER、neteaseapi/urls 的 NE_LADDER、settings 的枚举校验）是各自独立的
// 字面量，此前没有任何东西把它们绑在一起——主进程加一档，渲染侧不报错，那档只是静默选不到。
describe('档位表跨层同集（选择器 ↔ 主进程降级链）', () => {
  it('QQ 选择器与 QUALITY_LADDER 同集同序（顺序即降级顺序，也是选择器显示顺序）', () => {
    expect(qualitiesFor('qq').map((x) => x.v)).toEqual([...QUALITY_LADDER])
  })

  it('网易云选择器与 NE_LADDER 同集同序', () => {
    expect(qualitiesFor('netease').map((x) => x.v)).toEqual([...NE_LADDER])
  })

  it('选择器里的每一档都过主进程枚举校验，且默认档在选择器可见（否则首屏就是非法档）', () => {
    for (const x of qualitiesFor('qq')) expect(isValidQuality(x.v)).toBe(true)
    for (const x of qualitiesFor('netease')) expect(isValidQuality(x.v)).toBe(true)
    expect(qualitiesFor('qq').some((x) => x.v === DEFAULT_SETTINGS.quality)).toBe(true)
  })

  it('labelForQuality 的超集假设成立：网易云每档都与同名 QQ 档逐字同标签', () => {
    // 中文名只有一张表（QQ_QUALITIES）。网易云若出现 QQ 没有的档，或两侧同档改名不同步，
    // 降级徽标就会回显「低品质」——这条把「超集」前提钉住，而不是默认它永远成立。
    for (const ne of qualitiesFor('netease')) {
      expect(qualitiesFor('qq').find((x) => x.v === ne.v)?.label).toBe(ne.label)
      expect(labelForQuality(ne.v)).toBe(ne.label)
    }
  })

  it('UiQuality 与主进程 Quality 同集（类型层：任何一侧越界都编译不过）', () => {
    const tied: Exactly<UiQuality, MainQuality> = true
    expect(tied).toBe(true)
  })

  it('UiTrack 与主进程 TrackDTO 同字段集（类型层：专辑序号漏声明即 tsc 红灯）', () => {
    // 同形类型是手抄的（渲染工程不 import 主进程模块，原因见 stores/download.ts 头注），漏抄只会
    // 静默丢字段；可选字段双向可赋，所以钉 keyof 同集而不是单向可赋。
    const tied: Exactly<keyof UiTrack, keyof MainTrackDTO> = true
    expect(tied).toBe(true)
  })

  it('UiAlbumBundle 与主进程 AlbumBundle 同形（整张下载的批次元数据回传不丢字段）', () => {
    // Task 13 要把渲染侧持有的 bundle 原样送回 dl:enqueue → 主进程拿它算目录与 cue。
    // 镜像类型少一个字段（或主进程把某字段改成可选）时，双向可赋仍成立、只有同集断言会红。
    const tied: Exactly<UiAlbumBundle, AlbumBundle> = true
    expect(tied).toBe(true)
  })
})

// ---------- Task 13：「下载整张」的文案 ----------
// .vue 挂不起来（vitest 是 node 环境、无 jsdom，`<script setup>` 也导不出可 import 的东西），
// 所以这里钉的是两个组件**真正 import 的那两个生产函数**——文案只此一份，
// App.vue 与 NeteaseTab.vue 里只剩 {{ }} 与 @click，不再写一遍断言模板复制品。
describe('「下载整张」文案（0.7.0 Task 13）', () => {
  const album: UiAlbumBundle = {
    source: 'qq', id: 'm1', name: '奇爱人生 LOVE ELEGIA', artist: '阿良良木健',
    date: '2019-05-20', company: '', coverUrl: '', totalTracks: 10, discs: [1], discTotals: { 1: 10 },
  }

  it('残缺批次确认：说死「这批不生成 album.cue」并给出补齐路子', () => {
    const s = albumPartialConfirm(album, 2)
    expect(s).toContain('奇爱人生 LOVE ELEGIA')   // 队列里多张专辑时只能靠名字分辨
    expect(s).toContain('共 10 首')               // 已加载数与专辑真实数都要出现
    expect(s).toContain('只加载了 2 首')
    expect(s).toContain('album.cue 不会生成')
    expect(s).toContain('再点一次「下载整张」')
    // 计划稿原文是「.cue 要等整张下齐才生成」——听着像「稍等就有」，实际这批永远没有，
    // 不许把那句错误的承诺写回来。
    expect(s).not.toContain('要等整张下齐才生成')
    // 也不许许诺「自动把剩下的下完」：没加载的曲目本版本不去取
    expect(s).not.toMatch(/自动(加载|补齐|下载)/)
    expect(s.split('\n').length).toBeGreaterThanOrEqual(4)  // confirm 是纯文本，不分行读不完
  })

  it('入队回显两种说法：残缺那句必须带着「这批没有 cue」，整张那句不许留悬念', () => {
    const partial = albumEnqueuedNotice(album, 2)
    expect(partial).toContain('2 首')
    expect(partial).toContain('共 10 首')
    expect(partial).toContain('不会有 album.cue')
    const full = albumEnqueuedNotice(album, 10)
    expect(full).toContain('整张')
    expect(full).not.toContain('不会有')
  })

  it('多碟专辑的整张回显不承诺「一张 cue」：每碟各写一份（spec §5.5）', () => {
    const multi: UiAlbumBundle = { ...album, discs: [1, 2], discTotals: { 1: 6, 2: 4 } }
    expect(albumEnqueuedNotice(multi, 10)).toContain('本碟 album.cue')
  })
})
