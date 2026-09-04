import fs from 'node:fs'
import path from 'node:path'

export function safeName(name: string, maxLength = 100): string {
  let out = name.replace(/[\\/:*?"<>|]/g, '-').trim()
  if (!out) out = 'untitled'
  if (out.length > maxLength) out = `${out.slice(0, maxLength - 3)}...`
  return out
}

export function uniquePath(dest: string): string {
  if (!fs.existsSync(dest)) return dest
  const ext = path.extname(dest)
  const base = dest.slice(0, -ext.length)
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}(${i})${ext}`
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new Error('无法生成不重复的文件名')
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}