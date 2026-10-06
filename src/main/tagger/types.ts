export interface TagMeta {
  title: string
  artist: string
  album: string
  date: string        // 'YYYY-MM-DD' 或 ''
  copyright: string
  genre: string
  lyrics: string      // 纯文本或 LRC 文本（含 [mm:ss.xx] 行）；空 = 不写歌词
  // 专辑封装（整张下载）才有；缺省 = 不写这一帧/键，平铺下载产物逐字节不变。
  track?: number
  trackTotal?: number
  disc?: number
  discTotal?: number
  cover?: Buffer
  coverMime?: string  // 'image/jpeg' | 'image/png'
}