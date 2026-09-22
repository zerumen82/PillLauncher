# PillLauncher

**Launcher universal de aplicaciones con terminal integrada, editor de código y debugger.**

PillLauncher es una app de escritorio (Windows) construida con Tauri v2 y React para abrir cualquier carpeta de proyecto y trabajar sin salir de una sola ventana: compilar, ejecutar, depurar, editar código, explorar archivos y usar Git.

## Características

- **Launcher universal** — abre cualquier carpeta; detecta Maven, Gradle, CMake, Make o cae en modo terminal puro.
- **Terminal integrada** — múltiples pestañas por proyecto (PTY + fallback pipe), resize automático, pegado inteligente (Ctrl+C / Ctrl+V con selección).
- **Editor de código** — Monaco (el de VS Code): outline, búsqueda, guardado con Ctrl+S, pestañas, vista diff de Git.
- **Debugger JDWP** — adjunta `jdb` al puerto del JVM, breakpoints con un click en el gutter, step/over/out/continue, variables y stack en vivo.
- **Git integrado** — stage/unstage, commit, stash, branches, pull/push/fetch, historial y badges de estado por archivo en el árbol.
- **Explorador de archivos** — árbol con archivos ocultos, crear archivos/carpetas, click derecho, abrir en Explorador de Windows.
- **Búsqueda global** — Ctrl+P busca archivos por nombre; en consola, las rutas `archivo.java:42` son clickeables.
- **Configuración persistente** — proyectos recientes, tamaño de fuentes, breakpoints y estado de pestañas sobreviven a reinstalaciones (`tauri-plugin-store`).

## Stack

| Capa | Tecnología |
|------|------------|
| Backend / shell | [Tauri v2](https://tauri.app) (Rust) |
| Frontend | React 19 + Vite + Tailwind CSS 4 |
| Terminal | xterm.js + portable-pty |
| Editor | Monaco Editor |
| Updater | tauri-plugin-updater (firmado; ver notas) |

## Requisitos

- Node.js ≥ 20 y npm
- Rust (`rustup`) con toolchain stable
- Windows 10/11 (PTY con ConPTY; `pwsh` recomendado)
- JDK con `jdb` en el PATH solo si vas a depurar Java

## Comandos

```bash
npm install        # dependencias frontend
npm run dev        # desarrollo (Vite)
npm run build      # build de producción del frontend
npm test           # tests de regresión de config (seguridad/permisos)
npm run lint       # ESLint

cd src-tauri
cargo build --release   # binario Tauri (producción)
cargo check             # chequeo rápido del backend
```

Para empaquetar el instalador (MSI/NSIS): `npm run installer`.

## Estructura

```
src/            Frontend React (main.jsx, FileTree, EditorModal, DebugPanel, ...)
src-tauri/      Backend Rust (main.rs: terminales, FS, git, debugger jdb)
tests/          Tests de regresión (CSP, permisos, allowlist, scripts)
eslint.config.js  Lint flat config (ESLint 9)
```

## Seguridad

- **CSP real** en `tauri.conf.json` (sin `unsafe-inline` en scripts); `assetProtocol` deshabilitado.
- **Sin permisos `fs:*` ni `shell:*`** — el filesystem pasa por comandos Rust con `ensure_allowed`: allowlist `ALLOWED_ROOTS` registrada con `register_root` al abrir un proyecto; rutas `..` y rutas fuera del proyecto son rechazadas.
- **Sin plugin shell** — no hay ejecución arbitraria de procesos desde el frontend.
- El updater requiere firma: `plugins.updater.pubkey` se rellena con `npx tauri signer generate` antes de publicar releases.

## Branding

- **Nombre:** PillLauncher · **Identifier:** `com.pill.launcher`
- **Icono:** cápsula fluorescente

## Licencia

Ver el repositorio para detalles de licencia.
