# PillLauncher

Launcher universal de aplicaciones con terminal integrada, editor de código y debugger.

## Comandos útiles

```bash
# Desarrollo frontend
npm run dev

# Build frontend
npm run build

# Tests (regresión de config) y lint
npm test
npm run lint

# Build Tauri (producción)
cd src-tauri && cargo build --release

# Generar iconos (PowerShell)
powershell -File gen-icon.ps1
```

## Estructura

- `src/` — Frontend React + Vite + Tailwind
- `src-tauri/` — Backend Rust (Tauri v2)
- `gen-icon.ps1` — Script para generar icono de la app

## Notas tecnicas

- **Abrir en Explorador**: usar el helper `src/openInExplorer.js` (archivo -> `revealItemInDir` deja el archivo seleccionado; carpeta -> `openPath`).
  Requiere scope en `src-tauri/capabilities/default.json`:

      {
        "identifier": "opener:allow-open-path",
        "allow": [{ "path": "**" }]
      }

  Si se declara como string simple (`"opener:allow-open-path"`), el permiso queda con scope vacio y Tauri
  rechaza la llamada (`ForbiddenPath`) sin abrir nada: el explorador no se abre y el error se pierde si el
  `.catch()` esta vacio.
- **Listado de carpetas**: `list_dir(path, show_hidden)`; `showHidden` (default `true`) incluye los dotfiles
  (`.github`, `.vscode`, `.gitignore`, ...). El toggle de la cabecera del arbol lo controla.
- **Crear archivos/carpetas**: desde el arbol (`click derecho` en una carpeta o `CreateInput` en la raiz) o
  desde el panel superior (siempre en la raiz del proyecto, se muestra la carpeta destino).
- **Updater**: `plugins.updater.pubkey` esta vacio a proposito. Antes de publicar releases firmar con
  `npx tauri signer generate` y pegar la pubkey en `src-tauri/tauri.conf.json` (no generar claves en silencio).
- **Seguridad**: CSP real en `tauri.conf.json` (sin `unsafe-inline` en scripts), `assetProtocol` deshabilitado,
  sin permisos `fs:*`/`shell:*` — el FS pasa por comandos Rust con `ensure_allowed` (allowlist `ALLOWED_ROOTS`,
  registrar con `register_root` al abrir proyecto).

## Branding

- **Nombre:** PillLauncher
- **Identifier:** com.pill.launcher
- **Icono:** Cápsula color fluorescente
