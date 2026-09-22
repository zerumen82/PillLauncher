import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';

// ── Utilidades de rutas (Windows-first, toleran '/' y '\') ──────────────

export function baseName(p) {
  if (!p) return '';
  const clean = String(p).replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

export function dirName(p) {
  if (!p) return '';
  const clean = String(p).replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
  if (idx < 0) return '';
  if (idx === 0) return clean.slice(0, 1);                                   // /home -> /
  if (idx === 2 && /^[a-zA-Z]:$/.test(clean.slice(0, 2))) return clean.slice(0, 3); // C:\foo -> C:\
  return clean.slice(0, idx);
}

export function joinPath(base, name) {
  if (!base) return name || '';
  const sep = base.includes('\\') ? '\\' : '/';
  return base.replace(/[\\/]+$/, '') + sep + (name || '');
}

/** Ruta de `target` relativa a `root` (o `target` si no está dentro). */
export function relativeTo(root, target) {
  if (!root || !target) return target || '';
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root);
  const t = norm(target);
  if (t === r) return '.';
  if (t.startsWith(r + '/')) return t.slice(r.length + 1);
  return target;
}

// ── Abrir en el Explorador de Windows ───────────────────────────────────

/**
 * Abre `targetPath` en el Explorador del sistema.
 * - Carpeta  -> abre la carpeta
 * - Archivo  -> abre la carpeta contenedora con el archivo seleccionado
 * Si un método falla, prueba el siguiente y devuelve un error con el detalle
 * de cada intento (nunca falla en silencio).
 */
export async function openInExplorer(targetPath, { isDir = false } = {}) {
  const path = String(targetPath || '').trim();
  if (!path) throw new Error('ruta vacía');

  const parent = dirName(path);
  const hasParent = Boolean(parent) && parent !== path;

  const steps = isDir
    ? [
        ['abrir carpeta', () => openPath(path)],
        hasParent ? ['abrir carpeta padre', () => openPath(parent)] : null,
      ]
    : [
        ['seleccionar archivo', () => revealItemInDir(path)],
        hasParent ? ['abrir carpeta contenedora', () => openPath(parent)] : null,
        ['abrir archivo', () => openPath(path)],
      ];

  const problems = [];
  for (const step of steps) {
    if (!step) continue;
    const [label, run] = step;
    try {
      await run();
      return path;
    } catch (e) {
      problems.push(`${label}: ${e?.message || e}`);
    }
  }
  throw new Error(problems.join(' | ') || 'no se pudo abrir el Explorador');
}
