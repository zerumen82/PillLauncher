# PillLauncher

Launcher universal de aplicaciones con terminal integrada, editor de código y debugger.

## Comandos útiles

```bash
# Desarrollo frontend
npm run dev

# Build frontend
npm run build

# Build Tauri (producción)
cd src-tauri && cargo build --release

# Generar iconos (PowerShell)
powershell -File gen-icon.ps1
```

## Estructura

- `src/` — Frontend React + Vite + Tailwind
- `src-tauri/` — Backend Rust (Tauri v2)
- `gen-icon.ps1` — Script para generar icono de la app

## Branding

- **Nombre:** PillLauncher
- **Identifier:** com.pill.launcher
- **Icono:** Cápsula color fluorescente
