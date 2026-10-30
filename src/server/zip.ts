import { crc32 } from 'node:zlib';

export interface ZipEntry { name: string; data: Buffer }

/**
 * 打包导出用的最小 ZIP 实现。采用 STORE（不压缩），因为内容是 PNG 与纯文本，
 * 再压缩没有收益；不引入第三方依赖。文件名按 UTF-8 标记，中文平台名在解包时保持原样。
 */
export function createZip(entries: ZipEntry[], timestamp = new Date()): Buffer {
  const dosTime = (timestamp.getHours() << 11) | (timestamp.getMinutes() << 5) | Math.floor(timestamp.getSeconds() / 2);
  const dosDate = ((timestamp.getFullYear() - 1980) << 9) | ((timestamp.getMonth() + 1) << 5) | timestamp.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const sum = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, entry.data);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + entry.data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

/** ZIP 内部路径只能是相对路径，防止导出包写入任意位置或包含父目录跳转。 */
export function safeZipName(...parts: string[]): string {
  const cleaned = parts.map(part => part.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '_')).filter(Boolean);
  return cleaned.join('/');
}
