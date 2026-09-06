# 解密模块移植进度（2026-09-06 中断存档）

> 状态：**算法分析完成、参考源码已本地化，TS 移植未开始**（因 QQ 登录问题插队）。
> 参考：`showhwa/UnlockMusicProject_Archive`（GitHub）`tmp/cli/algo/qmc/`（Go，MIT），真实验证样本已复制到 `tests/fixtures/qmc/`（23 个 bin，672KB）。

## 已确认的算法（Go 源码直读结论）

### 文件流（qmc.go Decoder.searchKey + Validate + Read）
1. 读末尾 4 字节判定类型：
   - `"QTag"` → readRawMetaQTag：再往前 4 字节（BE）rawMetaLen，从 `-(8+rawMetaLen)` 起读 rawMetaLen 字节，内容 `base64key,songID,extra`（逗号分隔 3 段，key 取 items[0]）；`audioLen = fileSize - 8 - rawMetaLen`
   - `"STag"` → 报错（无密钥）
   - `"cex\0"`（musicex）→ MusicExTag：尾部 16 字节 [TagSize LE@0, TagVersion@4, "musicex\0"@8]；需 TagVersion==1 且 TagSize>=0xC0；audioLen = fileSize - TagSize；**密钥只能从 MMKV 取（Mac/Android），Windows 侧无密钥 → 直接报错**（Windows 客户端用 QTag/raw-key 路径）
   - 其它：size = LE uint32(suffix)；`0 < size <= 0xFFFF` → readRawKey：audioLen = seek(-(4+size))，key=最后 size 字节（去尾 NUL）→ deriveKey；否则 → static 密码（legacy qmc0），audioLen = fileSize
2. 密文选择（NewQmcCipherDecoder）：derived key 长度 **>300 → RC4**；非空 → map；空 → static
3. 校验：解密首 64 字节后嗅探容器魔数（fLaC/OggS/MP3 等）→ 失败抛「detect file type failed」
4. 输出：对 audioLen 长的数据按 offset 语义逐块解密 → 原容器明文（flac→.flac、ogg→.ogg、mp3→.mp3）

### 密钥派生（key_derive.go）
- `simpleMakeKey(106, 8)`：`byte(abs(tan(salt + i*0.1)) * 100)`，期望 `[0x69,0x56,0x46,0x38,0x2b,0x20,0x15,0x0b]`（有 Go 向量）
- `deriveKey`：base64 解码 → 可选前缀 `"QQMusic EncV2,Key:"` → v2 先 TEA-dec(deriveV2Key1) 再 TEA-dec(deriveV2Key2) 再 base64 → v1：TEA key16 = interleave(simpleKey[8], rawKey[:8]) → `decryptTencentTea(rawKey[8:], teaKey)` → 输出 = rawKey[:8] + 解密结果
- **TencentTEA**：标准 TEA 32 轮（golang tea.NewCipherWithRounds(key,32)），CBC 变体：P_n = D(decBuf_{n-1} XOR ct_n)，输出字节再 XOR ivPrev（= 上一 ct 块）；salt 跳 2 字节（起始 destIdx=1+padLen，padLen=第一块解密后 b0&7），末尾 7 字节 zero-check。**务必逐字节按 Go 移植，用 key_derive_test 向量（mflac0_rc4 512 字节 key_raw→key、mflac_map/mflac_rc4/mgg_map 256）验证**
- v2 常量：deriveV2Key1 = `33 38 36 5A 4A 59 21 40 23 2A 24 25 5E 26 29 28`；deriveV2Key2 = `2A 2A 23 21 28 23 24 25 26 5E 61 31 63 5A 2C 54`

### 密码器（可直接照抄）
- **static**（cipher_static.go）：`idx=(offset*offset+27)&0xff`，staticCipherBox 256 字节表（见 Go 源）；offset>0x7FFF 取模 0x7FFF
- **map**（cipher_map.go）：`idx=(offset*offset+71214)%size`（size=key 长度），`rotate(v, (idx&0x7+4)%8)`，`buf ^= rotate(key[idx],…)`
- **RC4 段式**（cipher_rc4.go）：hash=key 字节连乘（遇 0 跳过；溢出 break）；首段 128 字节 `buf[i] ^= key[getSegmentSkip(offset+i)]`（getSegmentSkip: `int64(float64(hash)/float64((id+1)*seed)*100) % n`，**float64 除法语义与 JS 相同**）；段长 5120，普通段用 box 洗牌（skipLen = offset%5120 + getSegmentSkip(offset/5120)）

### Go 测试向量（fixture 已入库）
- `{name}_key.bin`=派生后 key、`_key_raw.bin`=原始 ekey、`_raw.bin`+`_suffix.bin`=完整加密文件、`_target.bin`=期望明文
- 端到端用例（qmc_test.go）：mflac0_rc4(.mflac0)、mflac_rc4(.mflac)、mflac_map(.mflac)、mgg_map(.mgg)、qmc0_static(.qmc0) —— raw+suffix 拼接 → 解密 → 与 target 逐字节相等
- 注意 mflac0_rc4 的 suffix 是 **724 字节**（= 4 字节长度 + 720 字节 ekey？）——readRawKey 按 size 读取的形态，实现时按 size 语义走

## 待办（继续时从这开始）
1. `src/main/unlock/tea.ts`（TEA-32 轮 + TencentTEA-CBC，用 key_derive 向量单测）
2. `src/main/unlock/derive.ts`（simpleMakeKey/deriveKey V1+V2）
3. `src/main/unlock/ciphers.ts`（static/map/rc4，用 cipher_map/rc4 单测 + mflac0_rc4 分段用例）
4. `src/main/unlock/decrypt.ts`（QTag/raw-key/musicex/static 四路径 + 容器嗅探 + 整文件解密）
5. 解密 Tab UI + IPC（unlock:run；输出目录 settings.decryptOutDir；结果列表 ✓ 补全 / ○ 仅解密 / ✗ 原因）
6. 补全管线：文件名「曲名 - 歌手」拆分 → qqapi 搜索匹配 → 元数据/封面/歌词 → tagFile（flac 支持；ogg 输出暂不补标签）
7. scope：.mflac/.mflac0/.mgg/.mgg0/.mgg1 + qmc0 静态兜底；musicex 无密钥直接报错提示