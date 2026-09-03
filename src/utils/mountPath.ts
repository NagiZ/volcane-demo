/** 取安全 basename：去掉路径分隔符与危险片段。 */
export function sanitizeBasename(originalName: string): string {
  const base = originalName.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
  const cleaned = base.replace(/^\.+/, '').trim();
  return cleaned.length > 0 ? cleaned : 'file';
}

function splitNameExt(basename: string): { stem: string; ext: string } {
  const i = basename.lastIndexOf('.');
  if (i <= 0) return { stem: basename, ext: '' };
  return { stem: basename.slice(0, i), ext: basename.slice(i) };
}

function shortIdSuffix(fileId: string): string {
  const raw = fileId.replace(/^file-/, '');
  return raw.slice(-8) || raw || 'dup';
}

/** 同名冲突时第二个起追加短 file_id 后缀。 */
export function allocateMountBasenames(
  items: Array<{ fileId: string; name: string }>,
): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const item of items) {
    let candidate = sanitizeBasename(item.name);
    if (used.has(candidate)) {
      const { stem, ext } = splitNameExt(candidate);
      candidate = `${stem}-${shortIdSuffix(item.fileId)}${ext}`;
      let n = 2;
      while (used.has(candidate)) {
        candidate = `${stem}-${shortIdSuffix(item.fileId)}-${n}${ext}`;
        n += 1;
      }
    }
    used.add(candidate);
    out.set(item.fileId, candidate);
  }
  return out;
}

export function arkMountPath(basename: string): string {
  return `/${basename.replace(/^\/+/, '')}`;
}

export function sandboxUploadPath(basename: string): string {
  return `/mnt/session/uploads/${basename.replace(/^\/+/, '')}`;
}
