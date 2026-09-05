export interface TagMeta {
  title: string
  artist: string
  album: string
  date: string        // 'YYYY-MM-DD' 或 ''
  copyright: string
  genre: string
  lyrics: string      // 纯文本或 LRC 文本（含 [mm:ss.xx] 行）；空 = 不写歌词
  cover?: Buffer
  coverMime?: string  // 'image/jpeg' | 'image/png'
}