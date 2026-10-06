import path from 'node:path'
import { safeName } from './fsUtils'
import type { TrackDTO } from './qqapi/tracks'

/** 一张专辑的批次上下文：随 DownloadJob 传递、渲染侧原样回传，所以必须是纯数据（可结构化克隆）。
 *  本模块只描述「一张专辑」在落盘层面需要什么，不解析两源原始 JSON——曲目映射沿用各自 api 模块里
 *  已经有测试的实现（trackFromEntry / neteaseTrackToDto / isVipEntry），在这里重写等于复制 VIP 判据，
 *  还会造成 albumBundle ↔ qqapi/tracks 的循环 import（这里只 import 它的类型）。 */
export interface AlbumBundle {
  source: 'qq' | 'netease'
  id: string            // QQ albummid / 网易云 album.id 的字符串形式（cue 与完成度键要用）
  name: string
  artist: string
  date: string          // 'YYYY-MM-DD'，可能空串（认不出就是空串，见 normalizeDate）
  company: string       // 可能空串（网易云 album.company 实测可为 null）
  coverUrl: string      // 可能空串（空则不写 cover.jpg）
  totalTracks: number   // 曲目数组**实长**——服务端 total_song_num 与 list.length 同一张专辑实测 21 vs 22
                        //（网易云 album.size 与 songs.length 实测一致），口径不统一就一律以实长为准
  discs: number[]       // 去重升序碟号；长度 1 即单碟。恒非空，下游可直接 discs[0]
}

/** 专辑接口的返回形状：一次请求同时给出批次上下文与带序号的曲目（Task 6/7 生产、Task 8 透传给渲染侧） */
export interface AlbumPage {
  bundle: AlbumBundle
  tracks: TrackDTO[]
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/

/** 发行日归一：两源字段格式本次（2026-10-06 探针）未逐值验证——QQ `data.aDate` 观察到 'YYYY-MM-DD'，
 *  网易云 `album.publishTime` 通常是毫秒时间戳，但都没有样本可证。归一后下游只面对一种格式，
 *  目录名取年份与 cue 的 REM DATE 才不会被脏值带崩。只认 10/13 位时间戳与 ^\d{4}-\d{2}-\d{2} 前缀，
 *  其余一律空串——宁可少一行 REM DATE，也不猜出一个假日期。 */
export function normalizeDate(v: unknown): string {
  if (typeof v === 'string') {
    const s = v.trim()
    if (DATE_RE.test(s)) return s.slice(0, 10)
    if (/^\d{10}$/.test(s) || /^\d{13}$/.test(s)) return normalizeDate(Number(s))
    return ''
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const ms = v < 1e11 ? v * 1000 : v          // 10 位按秒、13 位按毫秒（1e11 秒是 5138 年，不会误判）
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return ''    // 超出 Date 可表示范围的时间戳
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  return ''
}

/** 碟号采信：只有 ≥1 的整数才算一碟（网易云 `cd` 是 '01' 这种字符串，实测值，故数字串也认）。
 *  QQ 的 cdIdx/belongCD 字段存在已确认，但**取值语义未经多碟样本验证**（spec R1）：认不出就退化为
 *  单碟（1），因为「多碟被拍平成一个目录 + 连续序号」只是丢结构，而凭空造出碟号会生成不存在的
 *  CDnn 目录、cue 也写到错的地方。 */
export function discOf(v: unknown): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : 1
}

/** 组装批次上下文：元数据由各 api 模块取好再进来（日期已过 normalizeDate、曲目已带 disc），
 *  这里只收口回退名与碟号集合，不做解析。 */
export function mkBundle(
  source: 'qq' | 'netease', id: string, name: string, artist: string,
  date: string, company: string, coverUrl: string, tracks: TrackDTO[],
): AlbumBundle {
  const discs = [...new Set(tracks.map((x) => x.disc ?? 1))].sort((a, b) => a - b)
  return {
    source, id,
    name: name || '未知专辑',
    artist: artist || '未知歌手',
    date, company, coverUrl,
    totalTracks: tracks.length,
    discs: discs.length ? discs : [1],
  }
}

/** QQ 专辑封面大图 URL：响应内没有封面字段（实测 data 键表里无 pic 类字段），只能由 mid 拼。
 *  曲目自带的 cover 是 R300，做 cover.jpg 太小。R500 形态由 Task 6 Step 4 手工冒烟验 200 + JPEG 魔数，
 *  不成立就退回 T002R300x300（该形态已在 qqCoverUrl 生产验证）。 */
export function qqAlbumCoverUrl(albumMid: string): string {
  return albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg` : ''
}

/** 专辑目录名：歌手 - 专辑 (年)。与现有平铺命名同风格（用户拍定）；无日期时省略整个括号段，
 *  留个空括号会是个脏目录名。 */
export function albumDirName(b: AlbumBundle): string {
  const year = /^\d{4}-/.test(b.date) ? b.date.slice(0, 4) : ''
  return `${safeName(b.artist)} - ${safeName(b.name)}${year ? ` (${year})` : ''}`
}

/** 碟目录段：多碟时 CD01/CD02…，单碟不追加（专辑根目录即碟目录）。
 *  判据是「去重后的碟号集合长度 > 1」而不是单曲的 disc 值，避免半张专辑进 CD01、半张平铺。 */
export function discSegments(b: AlbumBundle, disc: number): string[] {
  return b.discs.length > 1 ? [`CD${String(disc).padStart(2, '0')}`] : []
}

/** 序号位数：≥100 首用三位，保证文件名按字典序即按曲目序 */
export function trackPad(b: AlbumBundle): number {
  return b.totalTracks >= 100 ? 3 : 2
}

/** 专辑根目录：downloadDir/歌手 - 专辑 (年)。cover.jpg 落这里。
 *  路径算式只此一份（连同 albumTrackDir），曲目落盘与附属文件写入共用——两处各拼一遍会漂移成
 *  cue 指向不存在的目录。 */
export function albumRootDir(downloadDir: string, b: AlbumBundle): string {
  return path.join(downloadDir, albumDirName(b))
}

/** 曲目落盘目录：多碟时在专辑根下再嵌 CDnn，单碟即专辑根目录。曲目与 album.cue 都写这里。 */
export function albumTrackDir(downloadDir: string, b: AlbumBundle, disc: number): string {
  return path.join(albumRootDir(downloadDir, b), ...discSegments(b, disc))
}

/** 不含扩展名的文件名：NN 曲名。safeName 只作用于曲名本身（与平铺下载同一套字符规则），
 *  整串一起过会让 '3 位前缀 + 空格' 占掉 safeName 的 100 字截断额度，把曲名多切几个字。
 *  trackNo 缺失按 1：QQ 服务端无序号字段（实测条目只有 belongCD/cdIdx），序号取数组下标 +1，
 *  而搜索/歌单等非专辑来源根本不填这两个字段，不能让它们拼出 'NaN 曲名'。 */
export function trackBaseName(t: Pick<TrackDTO, 'name' | 'trackNo'>, pad: number): string {
  const no = String(t.trackNo ?? 1).padStart(pad, '0')
  return `${no} ${safeName(t.name)}`
}

export function trackFileName(t: Pick<TrackDTO, 'name' | 'trackNo'>, pad: number, ext: string): string {
  return `${trackBaseName(t, pad)}.${ext}`
}
