newString>
# PillLauncher — Enhancements Design

## 1. Bug Fixes (main.rs)

| Bug | Line(s) | Fix |
|---|---|---|
| CMake section is Go copy | 304-323 | Replace with proper CMake commands: `cmake -S . -B build`, `cmake --build build`, `cmake --build build --target clean`, `ctest`, `cmake --install` |
| Java plain section is Python copy | 326-349 | Replace with `javac -d out src/**/*.java`, `java -cp out Main`, `javac -d out src/**/*.java && java -cp out Main` |
| Duplicate `run_cmd` in Maven | 89-90 | Remove first assignment (`run_cmd: "mvn -q exec:java".into()`) |
| Unused plugins in Cargo.toml | Cargo.toml | Remove `tauri-plugin-fs`, `tauri-plugin-cli`, `tauri-plugin-log` (not initialized) |

## 2. New Build Systems (main.rs)

10 new project types, each with detection + modes:

| System | Detection | Build | Clean | Rebuild | Run | Test | Other |
|---|---|---|---|---|---|---|---|
| Bazel | BUILD / WORKSPACE | bazel build //... | bazel clean | bazel clean && bazel build //... | bazel run //:target | bazel test //... | query, aquery, coverage, cquery |
| SBT (Scala) | build.sbt | sbt compile | sbt clean | sbt clean compile | sbt run | sbt test | package, assembly, doc |
| Mix (Elixir) | mix.exs | mix compile | mix clean | mix clean compile | mix run | mix test | format, deps.get, dialyzer, phx.server |
| Cabal (Haskell) | *.cabal / stack.yaml | cabal build | cabal clean | cabal clean && cabal build | cabal run | cabal test | haddock, repl, bench |
| Flutter/Dart | pubspec.yaml | flutter build | flutter clean | flutter clean && flutter build | flutter run | flutter test | analyze, format, pub get |
| Deno | deno.json / deno.lock | deno check | (none) | (none) | deno run main.ts | deno test | lint, fmt, compile |
| Bun | bun.lock | bun run build | (none) | (none) | bun run dev | bun test | lint, format, bun install |
| Nim | *.nimble / nim.cfg | nim compile | nim clean | nim clean && nim compile | nim run | nim test | cpp, doc, format (nph) |
| Zig | build.zig | zig build | zig build clean | zig build clean && zig build | zig build run | zig build test | fmt, build-exe |
| V | v.mod / vpkg.json | v build | v clean | v clean && v build | v run . | v test | fmt, doc, install |
| Docker | Dockerfile / compose.yaml | docker compose build | docker compose down -v | docker compose build --no-cache | docker compose up | (none) | compose up -d, logs, exec, push |
| Xcode/Swift | *.xcodeproj / Package.swift | xcodebuild / swift build | xcodebuild clean / swift clean | (clean build) | swift run | swift test | xcodebuild test, archive |

## 3. Extra Variants for Existing Systems

Each existing system gets additional modes:

- **Maven**: validate, checkstyle:check, spotbugs:check, PMD, dependency:tree, dependency:analyze
- **Gradle**: check, spotlessApply, lint, compileJava, compileTestJava, lombok config
- **Rust**: `cargo fmt --check`, `cargo outdated`, `cargo audit`, `cargo bench`, `cargo expand`
- **Node**: typecheck (tsc), format (prettier), ci (npm ci), e2e (cypress/playwright), storybook, chromatic
- **Python**: tox, mypy, flake8, coverage, black --check, isort
- **Go**: `go mod vendor`, `go generate ./...`, `go build -race`, `go test -race`, `golangci-lint`
- **.NET**: `dotnet format`, `dotnet tool restore`, `dotnet ef migrations`, `dotnet ef database update`

## 4. Text Editor (Code Editor) Modal

### Trigger
When user clicks a console log line matching pattern `(<path>:<line>:)` the modal opens.

### Stack
- **Monaco Editor** (`@monaco-editor/react`) — full code editor, syntax highlighting for 100+ languages, built-in search (Ctrl+F), line numbers
- **react-resizable-panels** — three resizable panels
- **Tauri command `read_file`** — reads file content + basic outline/class info
- **Tauri command `save_file`** — writes edited content back

### Layout
```
┌─────────────────────────────────────────────────────────┐
│ [←]  src/Main.java  [✕]    Save [Ctrl+S]        🔍    │
├──────────┬──────────────────────────┬────────────────────┤
│ OUTLINE  │   MONACO EDITOR          │   CLASS OVERVIEW   │
│ (tree)   │   (syntax highlight +    │   (auto-parsed)    │
│          │    line highlight at     │                    │
│          │    error line)           │   • class Main     │
│ class Foo│                          │   • +main()        │
│  └ run() │   EDITABLE               │   • +run()         │
│  └ calc()│                          │   • -logger:Logger │
│ function │                          │                    │
│  bar()   │                          │                    │
├──────────┴──────────────────────────┴────────────────────┤
│ [buscar...                                      ▲  ▼ ]  │
└─────────────────────────────────────────────────────────┘
```

### Panels
- **Outline** (left, resizable): tree of classes, methods, functions parsed from file
- **Monaco Editor** (center, resizable): full editor with error line highlight, auto-detect language from extension
- **Class Overview** (right, resizable): parsed class info — fields, methods, inheritance

### Keyboard shortcuts
- `Ctrl+S` / `Cmd+S`: save file
- `Escape`: close modal
- `Ctrl+F`: search (built-in Monaco)

### Error click flow
1. User clicks a log line containing `src/Foo.java:42:`
2. Regex extracts path, line number, column
3. `invoke('read_file', { path })` returns `{ content, lines, outline, classView }`
4. Modal opens with Monaco editor
5. Monaco reveals line 42 and adds a highlight decoration
6. Outline shows file structure; class overview shows class at that line

## 5. Frontend Changes

**New components:**
- `EditorModal.jsx` — modal wrapper with resizable panels
- `OutlinePanel.jsx` — file structure tree
- `ClassOverview.jsx` — parsed class info
- `SearchBar.jsx` — bottom search with prev/next navigation

**Modified files:**
- `main.jsx` — parse console logs for file:line patterns, make clickable, open EditorModal
- `index.css` — Monaco theme overrides, modal styles

## 6. Backend (Rust) Changes

**New commands:**
```rust
#[tauri::command]
fn read_file(path: String) -> Result<FileInfo, String>

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String>
```

**New types:**
```rust
struct FileInfo { content: String, lines: Vec<String>, outline: Vec<OutlineItem>, class_view: Option<ClassView>, language: String }
struct OutlineItem { kind: String, name: String, line: usize, children: Vec<OutlineItem> }
struct ClassView { name: String, methods: Vec<MethodInfo>, fields: Vec<FieldInfo>, extends: Option<String>, implements: Vec<String> }
struct MethodInfo { name: String, signature: String, line: usize, visibility: String }
struct FieldInfo { name: String, type_name: String, line: usize, visibility: String }
```

**File `lib.rs`** — will contain `read_file` and `save_file` implementations. `main.rs` stays as the entry point.

## 7. Dependencies

**Frontend (npm):**
- `@monaco-editor/react` — Monaco editor React wrapper
- `react-resizable-panels` — resizable split panes

**Backend (Cargo.toml):**
- `tauri-plugin-fs` — (re-add if needed for file ops, or use std::fs directly)

## 8. Files to Modify / Create

| File | Action |
|---|---|
| `src-tauri/Cargo.toml` | Add `tauri-plugin-fs`, remove unused plugins |
| `src-tauri/src/main.rs` | Fix bugs, add 10 new project types, extra variants |
| `src-tauri/src/lib.rs` | Add `read_file`, `save_file` commands + outline/class parsing |
| `src/main.jsx` | Add clickable log parsing + EditorModal integration, search bar |
| `package.json` | Add `@monaco-editor/react`, `react-resizable-panels` |
| `src/EditorModal.jsx` | **New** — modal with resizable panels |
| `src/OutlinePanel.jsx` | **New** — tree outline |
| `src/ClassOverview.jsx` | **New** — class overview panel |
| `src/SearchBar.jsx` | **New** — search input |
| `src/index.css` | Modal + Monaco styles |
