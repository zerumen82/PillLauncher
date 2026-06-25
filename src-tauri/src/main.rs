// Hide console window in release builds
#![windows_subsystem = "windows"]

use std::collections::HashMap;

use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::AtomicU32;
use std::sync::Mutex;
use std::thread;


/// Write to a debug log in %TEMP%\pill_terminal.log
#[allow(dead_code)]
fn debug_log(msg: &str) {
    let path = std::env::temp_dir().join("pill_terminal.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_micros();
        let _ = writeln!(f, "[{:016x}] {}", t, msg);
    }
}

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

static CHILD_PIDS: std::sync::LazyLock<Mutex<HashMap<String, u32>>> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_TERM_ID: AtomicU32 = AtomicU32::new(1);

#[cfg(windows)]
use std::os::windows::process::CommandExt;

// CREATE_NO_WINDOW for non-interactive commands (git, cmd /c, taskkill).
#[cfg(windows)]
const HIDDEN_PROCESS: u32 = 0x08000000; // CREATE_NO_WINDOW

#[cfg(windows)]
use windows::Win32::Foundation::*;
#[cfg(windows)]
use windows::Win32::System::Console::*;
#[cfg(windows)]
use windows::Win32::System::Threading::*;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::*;

// HANDLE is not Send in windows-rs 0.58; wrap it.
#[cfg(windows)]
#[derive(Clone, Copy)]
struct SendHandle(isize);
#[cfg(windows)]
unsafe impl Send for SendHandle {}
#[cfg(windows)]
impl SendHandle {
    fn from_h(h: HANDLE) -> Self { Self(h.0 as isize) }
    fn to_h(self) -> HANDLE { HANDLE(self.0 as *mut std::ffi::c_void) }
}

#[cfg(windows)]
static CONSOLE_IN: Mutex<Option<SendHandle>> = Mutex::new(None);
#[cfg(windows)]
static CONSOLE_OUT: Mutex<Option<SendHandle>> = Mutex::new(None);
#[cfg(windows)]
static CONSOLE_ALLOCATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(windows)]
fn init_hidden_console() {
    if CONSOLE_ALLOCATED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    unsafe {
        match AllocConsole() {
            Ok(()) => {
                debug_log("init_hidden_console: AllocConsole OK");
                // Hide immediately to minimize flash
                let hwnd = GetConsoleWindow();
                let _ = ShowWindow(hwnd, SW_HIDE);

                // Store input handle (for TTY stdin)
                let mut has_in = false;
                match GetStdHandle(STD_INPUT_HANDLE) {
                    Ok(h) if h != INVALID_HANDLE_VALUE => {
                        let mut dup = HANDLE::default();
                        match DuplicateHandle(
                            GetCurrentProcess(), h, GetCurrentProcess(),
                            &mut dup as *mut HANDLE, 0, BOOL(1),
                            DUPLICATE_SAME_ACCESS,
                        ) {
                            Ok(()) => {
                                if let Ok(mut guard) = CONSOLE_IN.lock() {
                                    *guard = Some(SendHandle::from_h(dup));
                                    debug_log("init_hidden_console: CONSOLE_IN stored");
                                    has_in = true;
                                }
                            }
                            Err(e) => debug_log(&format!("init_hidden_console: DuplicateHandle stdin failed: {:?}", e)),
                        }
                    }
                    _ => debug_log("init_hidden_console: GetStdHandle STD_INPUT_HANDLE failed"),
                }

                // Store output handle (for screen buffer polling)
                match GetStdHandle(STD_OUTPUT_HANDLE) {
                    Ok(h) if h != INVALID_HANDLE_VALUE => {
                        let mut dup = HANDLE::default();
                        match DuplicateHandle(
                            GetCurrentProcess(), h, GetCurrentProcess(),
                            &mut dup as *mut HANDLE, 0, BOOL(1),
                            DUPLICATE_SAME_ACCESS,
                        ) {
                            Ok(()) => {
                                // Enable reading from the console output buffer
                                let mut mode = CONSOLE_MODE::default();
                                let _ = GetConsoleMode(dup, &mut mode);
                                let _ = SetConsoleMode(dup, CONSOLE_MODE(mode.0 | 0x0004)); // ENABLE_PROCESSED_OUTPUT
                                if let Ok(mut guard) = CONSOLE_OUT.lock() {
                                    *guard = Some(SendHandle::from_h(dup));
                                    debug_log("init_hidden_console: CONSOLE_OUT stored");
                                }
                            }
                            Err(e) => debug_log(&format!("init_hidden_console: DuplicateHandle stdout failed: {:?}", e)),
                        }
                    }
                    _ => debug_log("init_hidden_console: GetStdHandle STD_OUTPUT_HANDLE failed"),
                }

                if !has_in {
                    debug_log("init_hidden_console: WARNING — no input handle available");
                }
            }
            Err(e) => debug_log(&format!("init_hidden_console: AllocConsole FAILED: {:?}", e)),
        }
    }
}

#[cfg(not(windows))]
fn init_hidden_console() {}

#[cfg(windows)]
fn hid_cmd(program: &str) -> Command {
    let mut c = Command::new(program);
    c.creation_flags(HIDDEN_PROCESS);
    c
}
#[cfg(not(windows))]
fn hid_cmd(program: &str) -> Command {
    Command::new(program)
}

enum TerminalBackend {
    Process { child: std::process::Child, stdin: std::process::ChildStdin },
    #[cfg(windows)]
    #[allow(dead_code)]
    Console { proc_handle: SendHandle, #[allow(dead_code)] child_pid: u32 },
    #[cfg(windows)]
    PortablePty {
        master: Box<dyn portable_pty::MasterPty + Send>,
        child: Box<dyn portable_pty::Child + Send + Sync>,
        writer: Box<dyn std::io::Write + Send>,
    },
}

struct TerminalSession {
    backend: TerminalBackend,
}

impl TerminalSession {
    fn write_stdin(&mut self, data: &[u8]) -> std::io::Result<()> {
        match &mut self.backend {
            TerminalBackend::Process { stdin, .. } => {
                stdin.write_all(data)?;
                stdin.flush()
            }
            #[cfg(windows)]
            TerminalBackend::Console { .. } => {
                write_console_input(data);
                Ok(())
            }
            #[cfg(windows)]
            TerminalBackend::PortablePty { writer, .. } => {
                writer.write_all(data)
            }
        }
    }

    fn flush_stdin(&mut self) -> std::io::Result<()> {
        match &mut self.backend {
            TerminalBackend::Process { stdin, .. } => stdin.flush(),
            #[cfg(windows)]
            TerminalBackend::Console { .. } => Ok(()),
            #[cfg(windows)]
            TerminalBackend::PortablePty { writer, .. } => writer.flush(),
        }
    }

    fn kill(&mut self) {
        match &mut self.backend {
            TerminalBackend::Process { child, .. } => {
                let _ = child.kill();
                let _ = child.wait();
            }
            #[cfg(windows)]
            TerminalBackend::Console { proc_handle, .. } => {
                unsafe {
                    let h = proc_handle.to_h();
                    let _ = TerminateProcess(h, 1);
                    let _ = CloseHandle(h);
                }
            }
            #[cfg(windows)]
            TerminalBackend::PortablePty { child, .. } => {
                let _ = child.kill();
            }
        }
    }
}

#[cfg(windows)]
#[allow(dead_code)]
fn resize_console_buffer(cols: u16, rows: u16) {
    if cols == 0 || rows == 0 { return; }
    let h = match CONSOLE_OUT.lock() {
        Ok(g) => match *g { Some(sh) => sh.to_h(), None => return },
        Err(_) => return,
    };
    unsafe {
        let size = COORD { X: cols as i16, Y: rows as i16 };
        let min_rect = SMALL_RECT { Left: 0, Top: 0, Right: 1, Bottom: 1 };
        let _ = SetConsoleWindowInfo(h, BOOL(1), &min_rect);
        let _ = SetConsoleScreenBufferSize(h, size);
        let rect = SMALL_RECT {
            Left: 0, Top: 0,
            Right: (cols as i16).saturating_sub(1).max(0),
            Bottom: (rows as i16).saturating_sub(1).max(0),
        };
        let _ = SetConsoleWindowInfo(h, BOOL(1), &rect);
    }
}

#[cfg(not(windows))]
fn resize_console_buffer(_cols: u16, _rows: u16) {}

#[cfg(windows)]
#[allow(dead_code)]
fn write_console_input(data: &[u8]) {
    let h = match CONSOLE_IN.lock() {
        Ok(g) => match *g {
            Some(sh) => sh.to_h(),
            None => return,
        },
        Err(_) => return,
    };

    let s = String::from_utf8_lossy(data);
    let chars: Vec<char> = s.chars().collect();
    let mut records: Vec<INPUT_RECORD> = Vec::with_capacity(chars.len() * 2);

    for &c in &chars {
        let vk = char_to_vk(c);
        let (key_down, key_up) = keyboard_records(vk, c as u16);
        records.push(key_down);
        records.push(key_up);
    }

    unsafe {
        let mut written: u32 = 0;
        let _ = WriteConsoleInputW(h, &records, &mut written);
    }
}

#[cfg(windows)]
#[allow(dead_code)]
fn char_to_vk(c: char) -> u16 {
    match c {
        '\r' | '\n' => 0x0D,
        '\t'         => 0x09,
        '\x08'       => 0x08,
        '\x1b'       => 0x1B,
        '\x7f'       => 0x08, // DEL → VK_BACK
        _            => 0,
    }
}

#[cfg(windows)]
#[allow(dead_code)]
fn keyboard_records(vk: u16, wch: u16) -> (INPUT_RECORD, INPUT_RECORD) {
    let down = INPUT_RECORD {
        EventType: KEY_EVENT as u16,
        Event: INPUT_RECORD_0 {
            KeyEvent: KEY_EVENT_RECORD {
                bKeyDown: BOOL(1),
                wRepeatCount: 1,
                wVirtualKeyCode: vk,
                wVirtualScanCode: 0,
                uChar: KEY_EVENT_RECORD_0 { UnicodeChar: wch },
                dwControlKeyState: 0,
            },
        },
    };
    let up = INPUT_RECORD {
        EventType: KEY_EVENT as u16,
        Event: INPUT_RECORD_0 {
            KeyEvent: KEY_EVENT_RECORD {
                bKeyDown: BOOL(0),
                wRepeatCount: 1,
                wVirtualKeyCode: vk,
                wVirtualScanCode: 0,
                uChar: KEY_EVENT_RECORD_0 { UnicodeChar: wch },
                dwControlKeyState: 0,
            },
        },
    };
    (down, up)
}

// ══════════════════════════════════════════════════
//  DATA TYPES
// ══════════════════════════════════════════════════

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProjectInfo {
  pub path:        String,
  pub typ:         String,
  pub label:       String,
  pub emoji:       String,
  pub color:       String,
  pub version:     String,
  pub modes:       Vec<BuildModeEntry>,
  pub profiles:    Vec<String>,
  pub gradle_tasks: Vec<GradleTask>,
  pub build_cmd:   String,
  pub clean_cmd:   String,
  pub run_cmd:     String,
  pub test_cmd:    String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BuildModeEntry {
  pub id:    String,
  pub label: String,
  pub cmd:   String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GradleTask {
  pub id:    String,
  pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LogLine {
  pub text: String,
  pub kind: String,
}

// ══════════════════════════════════════════════════
//  COMMANDS
// ══════════════════════════════════════════════════

#[tauri::command]
async fn detect_project(path: String) -> Result<ProjectInfo, String> {
  eprintln!("[DEBUG] detect_project called with path: {:?}", &path);
  let p = PathBuf::from(&path);
  if !p.exists() {
    eprintln!("[DEBUG] detect_project: path does not exist: {:?}", &p);
    return Err(format!("No existe: {}", path));
  }
  eprintln!("[DEBUG] detect_project: path exists, scanning for project type...");

  // ─── MAVEN ───
  if p.join("pom.xml").exists() {
    let mw = p.join("mvnw").exists();
    let b = if mw { "mvnw".to_string() } else { "mvn".to_string() };
    let profiles = read_maven_profiles(&p);
    let mut modes = vec![
      mode("clean",       "Limpiar",       format!("{} clean", b)),
      mode("compile",     "Compilar",      format!("{} compile", b)),
      mode("test",        "Test",          format!("{} test", b)),
      mode("package",     "Empaquetar",    format!("{} package -DskipTests", b)),
      mode("install",     "Instalar",      format!("{} install -DskipTests", b)),
      mode("verify",      "Verificar",     format!("{} verify", b)),
      mode("validate",    "Validate",      format!("{} validate", b)),
      mode("site",        "Site Docs",     format!("{} site", b)),
      mode("javadoc",     "JavaDoc",       format!("{} javadoc:javadoc", b)),
      mode("rebuild",     "Rebuild",       format!("{} clean compile", b)),
      mode("run",         "Ejecutar",      "java -cp target/classes Main".into()),
      mode("checkstyle",  "Checkstyle",    format!("{} checkstyle:check", b)),
      mode("pmd",         "PMD",           format!("{} pmd:pmd pmd:cpd", b)),
      mode("spotbugs",    "SpotBugs",      format!("{} spotbugs:check", b)),
      mode("dep.tree",    "Dep Tree",      format!("{} dependency:tree", b)),
      mode("dep.analyze", "Dep Analyze",   format!("{} dependency:analyze", b)),
      mode("owasp",       "OWASP Dep Check",format!("{} dependency-check:check", b)),
    ];
    for pr in &profiles {
      modes.push(mode(
        format!("profile:{}", pr),
        format!("▶ Profile: {}", pr),
        format!("{} clean package -P{} -DskipTests", b, pr),
      ));
    }
    return ok(ProjectInfo {
      path: path, typ: "maven".into(), label: "Maven".into(), emoji: "🟠".into(),
      color: "#f97316".into(),
      version: java_ver().unwrap_or_else(|| "-".into()),
      modes, profiles, gradle_tasks: vec![],
      build_cmd: format!("{} compile", b),
      clean_cmd: format!("{} clean", b),
      run_cmd:   format!("{} compile exec:java", b),
      test_cmd:  format!("{} test", b),
    });
  }

  // ─── GRADLE ───
  if p.join("build.gradle").exists() || p.join("build.gradle.kts").exists() || p.join("gradlew").exists() {
    let gw = p.join("gradlew").exists();
    let b = if gw { "gradlew".to_string() } else { "gradle".to_string() };
    let tasks = vec![
      GradleTask { id: "build".into(),            label: "Build".into() },
      GradleTask { id: "clean".into(),            label: "Clean".into() },
      GradleTask { id: "test".into(),             label: "Test".into() },
      GradleTask { id: "assemble".into(),         label: "Assemble".into() },
      GradleTask { id: "jar".into(),              label: "JAR".into() },
      GradleTask { id: "bootJar".into(),          label: "BootJar".into() },
      GradleTask { id: "bootRun".into(),          label: "BootRun".into() },
      GradleTask { id: "dependencies".into(),     label: "Dependencies".into() },
      GradleTask { id: "wrapper".into(),          label: "Wrapper".into() },
      GradleTask { id: "check".into(),            label: "Check".into() },
      GradleTask { id: "lint".into(),             label: "Lint".into() },
      GradleTask { id: "compileJava".into(),      label: "Compile Java".into() },
      GradleTask { id: "compileTestJava".into(),  label: "Compile Test".into() },
      GradleTask { id: "spotlessApply".into(),    label: "Spotless".into() },
      GradleTask { id: "jacocoTestReport".into(), label: "Jacoco Report".into() },
    ];
    let modes = vec![
      mode("clean",       "Clean",         format!("{} clean", b)),
      mode("build",       "Build",         format!("{} build", b)),
      mode("test",        "Test",          format!("{} test", b)),
      mode("assemble",    "Assemble",      format!("{} assemble", b)),
      mode("check",       "Check",         format!("{} check", b)),
      mode("jar",         "JAR",           format!("{} jar", b)),
      mode("bootRun",     "BootRun",       format!("{} bootRun", b)),
      mode("bootJar",     "BootJar",       format!("{} bootJar", b)),
      mode("deps",        "Deps",          format!("{} dependencies", b)),
      mode("wrapper",     "Wrapper",       format!("{} wrapper", b)),
      mode("rebuild",     "Rebuild",       format!("{} clean build", b)),
      mode("run",         "Ejecutar",      format!("{} bootRun", b)),
      mode("compileJava", "Compile Java",  format!("{} compileJava", b)),
      mode("compileTest", "Compile Test",  format!("{} compileTestJava", b)),
      mode("spotless",    "Spotless Apply",format!("{} spotlessApply", b)),
      mode("lint",        "Lint",          format!("{} lint", b)),
      mode("jacoco",      "Jacoco Report", format!("{} jacocoTestReport", b)),
    ];
    return ok(ProjectInfo {
      path: path, typ: "gradle".into(), label: "Gradle".into(), emoji: "🟢".into(),
      color: "#22c55e".into(),
      version: java_ver().unwrap_or_else(|| "-".into()),
      modes, profiles: vec![], gradle_tasks: tasks,
      build_cmd: format!("{} build", b),
      clean_cmd: format!("{} clean", b),
      run_cmd:   format!("{} bootRun", b),
      test_cmd:  format!("{} test", b),
    });
  }

  // ─── NODE / npm / yarn / pnpm ───
  if p.join("package.json").exists() {
    let pkg = std::fs::read_to_string(p.join("package.json")).unwrap_or_default();
    let scripts = extract_npm_scripts(&pkg);
    let has_yarn  = p.join("yarn.lock").exists();
    let has_pnpm  = p.join("pnpm-lock.yaml").exists() || p.join("pnpm-workspace.yaml").exists();
    let has_npm   = p.join("package-lock.json").exists();
    let (runner, lbl, emoji, color) = if has_pnpm {
      ("pnpm", "pnpm", "🟣", "#a855f7")
    } else if has_yarn {
      ("yarn",  "Yarn",  "🔵", "#3b82f6")
    } else if has_npm {
      ("npm",   "npm",   "🟢", "#ef4444")
    } else {
      ("npx",   "npx",   "⚡", "#64748b")
    };
    let r = runner.to_string();
    let mut modes = vec![
      mode("install",   "Instalar",    format!("{} install", r)),
      mode("build",     "Build",       format!("{} run build", r)),
      mode("rebuild",   "Rebuild",     format!("{} run build", r)),
      mode("test",      "Test",        format!("{} test", r)),
      mode("lint",      "Lint",        format!("{} run lint", r)),
      mode("typecheck", "Typecheck",   format!("{} run typecheck", r)),
      mode("format",    "Format",      format!("{} run format", r)),
    ];
    if p.join("tsconfig.json").exists() || find_file(&p, "*.ts").is_some() {
      modes.push(mode("tscheck", "TS Check", "npx tsc --noEmit".into()));
    }
    if p.join("cypress.config.ts").exists() || p.join("cypress.config.js").exists() || p.join("playwright.config.ts").exists() {
      modes.push(mode("e2e", "E2E", format!("{} run e2e", r)));
    }
    if p.join(".storybook").exists() || p.join("storybook").exists() {
      modes.push(mode("storybook", "Storybook", format!("{} run storybook", r)));
      modes.push(mode("chromatic", "Chromatic", format!("{} run chromatic", r)));
    }
    if scripts.contains_key("dev") {
      modes.push(mode("dev",     "Dev",     format!("{} run dev", r)));
    }
    if scripts.contains_key("start") {
      modes.push(mode("start",   "Start",   format!("{} start", r)));
    }
    if scripts.contains_key("preview") {
      modes.push(mode("preview", "Preview", format!("{} run preview", r)));
    }
    for (name, _cmd) in &scripts {
      if !matches!(name.as_str(), "build"|"dev"|"start"|"test"|"preview"|"lint") {
        modes.push(mode(
          format!("script:{}", name),
          format!("📜 {}", name),
          format!("{} run {}", r, name),
        ));
      }
    }
    return ok(ProjectInfo {
      path: path, typ: "node".into(), label: lbl.into(), emoji: emoji.into(),
      color: color.into(), version: "".into(),
      modes, profiles: vec![], gradle_tasks: vec![],
      build_cmd: format!("{} run build", r),
      clean_cmd: "".into(),
      run_cmd:   scripts.get("start").map(|c| format!("{} {}", r, c)).unwrap_or_else(|| format!("{} start", r)),
      test_cmd:  format!("{} test", r),
    });
  }

  // ─── .NET ───
  if has_dotnet(&p) {
    let modes = vec![
      mode("clean",    "Clean",        "dotnet clean".into()),
      mode("build",    "Build",        "dotnet build".into()),
      mode("rebuild",  "Rebuild",      "dotnet clean && dotnet build".into()),
      mode("run",      "Run",          "dotnet run".into()),
      mode("test",     "Test",         "dotnet test".into()),
      mode("publish",  "Publish",      "dotnet publish -c Release".into()),
      mode("watch",    "Watch Run",    "dotnet watch run".into()),
      mode("restore",  "Restore",      "dotnet restore".into()),
      mode("format",   "Format",       "dotnet format".into()),
      mode("toolrest", "Tool Restore", "dotnet tool restore".into()),
      mode("migrate",  "EF Migrate",   "dotnet ef migrations add Initial".into()),
      mode("dbupdate", "DB Update",    "dotnet ef database update".into()),
    ];
    return ok(ProjectInfo {
      path: path, typ: "dotnet".into(), label: ".NET".into(), emoji: "💜".into(),
      color: "#8661c1".into(),
      version: dotnet_ver().unwrap_or_else(|| "-".into()),
      modes, profiles: vec![], gradle_tasks: vec![],
      build_cmd: "dotnet build".into(),
      clean_cmd: "dotnet clean".into(),
      run_cmd:   "dotnet run".into(),
      test_cmd:  "dotnet test".into(),
    });
  }

  // ─── PYTHON ───
  if p.join("pyproject.toml").exists() || p.join("requirements.txt").exists()
    || p.join("Pipfile").exists() || py_files_any(&p) {
    let run = guess_py_entry(&p).unwrap_or_else(|| "python main.py".into());
    let mut modes = vec![
      mode("install",   "Instalar deps", "pip install -r requirements.txt".into()),
      mode("run",       "Ejecutar",      run.clone()),
      mode("rebuild",   "Rebuild",       "pip install -r requirements.txt && python -m py_compile src/**/*.py".into()),
      mode("test",      "Test",          "pytest".into()),
      mode("lint",      "Lint",          "pylint src".into()),
      mode("format",    "Format",        "black src".into()),
      mode("mypy",      "MyPy",          "mypy src".into()),
      mode("flake8",    "Flake8",        "flake8 src".into()),
      mode("coverage",  "Coverage",      "coverage run -m pytest && coverage report".into()),
      mode("tox",       "Tox",           "tox".into()),
      mode("blackchk",  "Black Check",   "black --check src".into()),
      mode("isort",     "Isort",         "isort src".into()),
    ];
    if p.join("manage.py").exists() {
      modes.push(mode("migrate",   "Migrate DB", "python manage.py migrate".into()));
      modes.push(mode("runserver", "Runserver",  "python manage.py runserver".into()));
    }
    return ok(ProjectInfo {
      path: path, typ: "python".into(), label: "Python".into(), emoji: "🐍".into(),
      color: "#3b82f6".into(),
      version: py_ver().unwrap_or_else(|| "-".into()),
      modes, profiles: vec![], gradle_tasks: vec![],
      build_cmd: "".into(), clean_cmd: "".into(),
      run_cmd: run, test_cmd: "pytest".into(),
    });
  }

  // ─── GO ───
  if p.join("go.mod").exists() {
    return ok(ProjectInfo {
      path: path, typ: "go".into(), label: "Go".into(), emoji: "🔵".into(),
      color: "#00add8".into(),
      version: go_ver().unwrap_or_else(|| "-".into()),
      modes: vec![
        mode("clean",    "Clean",          "go clean".into()),
        mode("build",    "Compilar",       "go build ./...".into()),
        mode("run",      "Ejecutar",       "go run .".into()),
        mode("test",     "Test",           "go test ./...".into()),
        mode("vet",      "Vet",            "go vet ./...".into()),
        mode("tidy",     "Mod tidy",       "go mod tidy".into()),
        mode("fmt",      "Format",         "go fmt ./...".into()),
        mode("rebuild",  "Rebuild",        "go clean && go build ./...".into()),
        mode("vendor",   "Mod vendor",     "go mod vendor".into()),
        mode("generate", "Generate",       "go generate ./...".into()),
        mode("race",     "Race Build",     "go build -race ./...".into()),
        mode("racetest", "Race Test",      "go test -race ./...".into()),
        mode("lint",     "Golangci-lint",  "golangci-lint run".into()),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: "go build ./...".into(), clean_cmd: "go clean".into(),
      run_cmd: "go run .".into(), test_cmd: "go test ./...".into(),
    });
  }

  // ─── RUST ───
  if p.join("Cargo.toml").exists() {
    let cargo_toml = std::fs::read_to_string(p.join("Cargo.toml")).unwrap_or_default();
    let is_workspace = cargo_toml.contains("[workspace]");
    let w = if is_workspace { " --workspace" } else { "" };
    let has_tauri = p.join("tauri.conf.json").exists();
    let mut modes = vec![
      mode("clean",    "Clean",        "cargo clean".into()),
      mode("check",    "Check",        "cargo check".into()),
      mode("build",    "Build",        format!("cargo build{}", w)),
      mode("run",      "Run",          format!("cargo run{}", w)),
      mode("test",     "Test",         format!("cargo test{}", w)),
      mode("rebuild",  "Rebuild",      format!("cargo clean && cargo build{}", w)),
      mode("clippy",   "Clippy",       "cargo clippy".into()),
      mode("fmt",      "Fmt",          "cargo fmt".into()),
      mode("fmtcheck", "Fmt --check",  "cargo fmt --check".into()),
      mode("doc",      "Doc",          "cargo doc --no-deps".into()),
      mode("release",  "Release",      format!("cargo build{} --release", w)),
      mode("bench",    "Bench",        format!("cargo bench{}", w)),
      mode("audit",    "Audit",        "cargo audit".into()),
      mode("outdated", "Outdated",     "cargo outdated".into()),
      mode("expand",   "Expand",       "cargo expand".into()),
    ];
    if has_tauri {
      modes.push(mode("toml",     "TOML Build",  "cargo tauri build".into()));
      modes.push(mode("toml.dev", "TOML Dev",    "cargo tauri dev".into()));
      modes.push(mode("toml.ios", "TOML iOS",    "cargo tauri ios build".into()));
      modes.push(mode("toml.android", "TOML Android","cargo tauri android build".into()));
    }
    let typ_label = if has_tauri { "tauri" } else if is_workspace { "rust-ws" } else { "rust" };
    let display_label = if has_tauri { "Tauri" } else if is_workspace { "Rust (Workspace)" } else { "Rust" };
    return ok(ProjectInfo {
      path: path, typ: typ_label.into(), label: display_label.into(),
      emoji: if has_tauri { "📦".into() } else { "🦀".into() },
      color: if has_tauri { "#ff4444" } else { "#ff6b35" }.into(),
      version: cargo_ver().unwrap_or_else(|| "-".into()),
      modes, profiles: vec![], gradle_tasks: vec![],
      build_cmd: if has_tauri { "cargo tauri build".into() } else { format!("cargo build{}", w) },
      clean_cmd: "cargo clean".into(),
      run_cmd: if has_tauri { "cargo tauri dev".into() } else { format!("cargo run{}", w) },
      test_cmd: format!("cargo test{}", w),
    });
  }

  // ─── C/C++ MAKE ───
  if p.join("Makefile").exists() {
    return ok(ProjectInfo {
      path: path, typ: "make".into(), label: "C/C++ (Make)".into(), emoji: "⚙️".into(),
      color: "#6b7280".into(), version: "".into(),
      modes: vec![
        mode("all",    "Make all",    "make".into()),
        mode("clean",  "Make clean",  "make clean".into()),
        mode("install","Make install","make install".into()),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: "make".into(), clean_cmd: "make clean".into(),
      run_cmd: "make run".into(), test_cmd: "make test".into(),
    });
  }

  // ─── C/C++ CMAKE ───
  if p.join("CMakeLists.txt").exists() {
    let has_build_dir = p.join("build").join("CMakeCache.txt").exists();
    let cfg = if has_build_dir { "" } else { "-S . -B build" };
    return ok(ProjectInfo {
      path: path, typ: "cmake".into(), label: "CMake".into(), emoji: "📐".into(),
      color: "#6b7280".into(),
      version: cmake_ver().unwrap_or_else(|| "-".into()),
      modes: vec![
        mode("configure","Configure", format!("cmake {} -DCMAKE_BUILD_TYPE=Debug", if cfg.is_empty() { String::from("-B build") } else { String::from(cfg) })),
        mode("build",    "Compilar",  "cmake --build build".into()),
        mode("clean",    "Clean",     "cmake --build build --target clean".into()),
        mode("rebuild",  "Rebuild",   "cmake --build build --clean-first".into()),
        mode("run",      "Ejecutar",  "cmake --build build --target run".into()),
        mode("test",     "Test",      "cd build && ctest".into()),
        mode("install",  "Instalar",  "cmake --install build".into()),
        mode("release",  "Release",   "cmake -S . -B build/release -DCMAKE_BUILD_TYPE=Release && cmake --build build/release".into()),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: "cmake --build build".into(), clean_cmd: "cmake --build build --target clean".into(),
      run_cmd: "cmake --build build --target run".into(), test_cmd: "cd build && ctest".into(),
    });
  }

  // ─── JAVA PLANO ───
  let java_files = java_count(&p);
  if java_files > 0 {
    let src_glob = if java_files <= 2 { "src/*.java" } else { "src/**/*.java" };
    let build_cmd = format!("javac -d out {}", src_glob);
    let main_class = guess_java_main(&p);
    let run_cmd = main_class.as_ref().map(|m| format!("java -cp out {}", m)).unwrap_or_else(|| "java -cp out Main".into());
    let modes = vec![
      mode("compile",   "Compilar",   build_cmd.clone()),
      mode("run",       "Ejecutar",   run_cmd.clone()),
      mode("rebuild",   "Rebuild",    format!("cmd /c if exist out rmdir /s /q out & {}", build_cmd)),
      mode("clean",     "Clean",      "cmd /c if exist out rmdir /s /q out".into()),
      mode("jar",       "JAR",        "jar cf app.jar -C out .".into()),
      mode("javadoc",   "JavaDoc",    "javadoc -d docs src/**/*.java".into()),
    ];
    return ok(ProjectInfo {
      path: path, typ: "java".into(), label: "Java".into(), emoji: "☕".into(),
      color: "#d97706".into(),
      version: java_ver().unwrap_or_else(|| "-".into()),
      modes, profiles: vec![], gradle_tasks: vec![],
      build_cmd, clean_cmd: "cmd /c if exist out rmdir /s /q out".into(),
      run_cmd, test_cmd: "".into(),
    });
  }

  // ─── BAZEL ───
  if p.join("BUILD").exists() || p.join("WORKSPACE").exists() || p.join("BUILD.bazel").exists() {
    return ok(ProjectInfo {
      path: path, typ: "bazel".into(), label: "Bazel".into(), emoji: "🔷".into(),
      color: "#43a047".into(), version: "".into(),
      modes: vec![
        mode("build",   "Build",   "bazel build //...".into()),
        mode("clean",   "Clean",   "bazel clean".into()),
        mode("rebuild", "Rebuild", "bazel clean && bazel build //...".into()),
        mode("run",     "Run",     "bazel run //:target".into()),
        mode("test",    "Test",    "bazel test //...".into()),
        mode("query",   "Query",   "bazel query //...".into()),
        mode("coverage","Coverage","bazel coverage //...".into()),
        mode("aquery",  "Aquery",  "bazel aquery //...".into()),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: "bazel build //...".into(), clean_cmd: "bazel clean".into(),
      run_cmd: "bazel run //:target".into(), test_cmd: "bazel test //...".into(),
    });
  }

  // ─── SBT (Scala) ───
  if p.join("build.sbt").exists() {
    return ok(ProjectInfo {
      path: path, typ: "sbt".into(), label: "SBT (Scala)".into(), emoji: "🔶".into(),
      color: "#c21325".into(), version: "".into(),
      modes: vec![
        mode("compile",  "Compilar",  "sbt compile".into()),
        mode("clean",    "Clean",     "sbt clean".into()),
        mode("rebuild",  "Rebuild",   "sbt clean compile".into()),
        mode("run",      "Ejecutar",  "sbt run".into()),
        mode("test",     "Test",      "sbt test".into()),
        mode("package",  "Package",   "sbt package".into()),
        mode("assembly", "Assembly",  "sbt assembly".into()),
        mode("doc",      "Doc",       "sbt doc".into()),
        mode("console",  "Console",   "sbt console".into()),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: "sbt compile".into(), clean_cmd: "sbt clean".into(),
      run_cmd: "sbt run".into(), test_cmd: "sbt test".into(),
    });
  }

  // ─── MIX (Elixir / Phoenix) ───
  if p.join("mix.exs").exists() {
    let has_phoenix = std::fs::read_to_string(p.join("mix.exs")).unwrap_or_default().contains(":phoenix");
    let mut modes = vec![
      mode("compile",  "Compilar",    "mix compile".into()),
      mode("clean",    "Clean",       "mix clean".into()),
      mode("rebuild",  "Rebuild",     "mix clean && mix compile".into()),
      mode("run",      "Ejecutar",    "mix run".into()),
      mode("test",     "Test",        "mix test".into()),
      mode("format",   "Format",      "mix format".into()),
      mode("deps",     "Deps get",    "mix deps.get".into()),
      mode("dialyzer", "Dialyzer",    "mix dialyzer".into()),
    ];
    if has_phoenix {
      modes.push(mode("phx.server", "Phoenix server", "mix phx.server".into()));
      modes.push(mode("phx.routes", "Phoenix routes","mix phx.routes".into()));
      modes.push(mode("phx.gen",    "Phoenix gen",   "mix phx.gen".into()));
    }
    return ok(ProjectInfo {
      path: path, typ: "elixir".into(), label: if has_phoenix {"Phoenix (Elixir)"} else {"Elixir (Mix)"}.into(),
      emoji: "💜".into(), color: "#4e2a8e".into(), version: "".into(),
      modes, profiles: vec![], gradle_tasks: vec![],
      build_cmd: "mix compile".into(), clean_cmd: "mix clean".into(),
      run_cmd: if has_phoenix {"mix phx.server".into()} else {"mix run".into()},
      test_cmd: "mix test".into(),
    });
  }

  // ─── CABAL (Haskell) ───
  let has_cabal = p.join("stack.yaml").exists() || glob_has(&p, "*.cabal");
  if has_cabal {
    let is_stack = p.join("stack.yaml").exists();
    let r = if is_stack { "stack" } else { "cabal" };
    return ok(ProjectInfo {
      path: path, typ: "haskell".into(), label: if is_stack {"Haskell (Stack)"} else {"Haskell (Cabal)"}.into(),
      emoji: "λ".into(), color: "#5e5086".into(), version: "".into(),
      modes: vec![
        mode("build",  "Build",    format!("{} build", r)),
        mode("clean",  "Clean",    format!("{} clean", r)),
        mode("rebuild","Rebuild",  format!("{} clean && {} build", r, r)),
        mode("run",    "Ejecutar", format!("{} run", r)),
        mode("test",   "Test",     format!("{} test", r)),
        mode("haddock","Haddock",  format!("{} haddock", r)),
        mode("repl",   "REPL",     format!("{} repl", r)),
        mode("bench",  "Bench",    format!("{} bench", r)),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: format!("{} build", r), clean_cmd: format!("{} clean", r),
      run_cmd: format!("{} run", r), test_cmd: format!("{} test", r),
    });
  }

  // ─── FLUTTER / DART ───
  if p.join("pubspec.yaml").exists() {
    let has_flutter = std::fs::read_to_string(p.join("pubspec.yaml")).unwrap_or_default().contains("flutter:");
    let (typ, label, emoji, color) = if has_flutter {
      ("flutter", "Flutter", "🟦", "#1389fd")
    } else {
      ("dart", "Dart", "🎯", "#0175c2")
    };
    return ok(ProjectInfo {
      path, typ: typ.into(), label: label.into(), emoji: emoji.into(), color: color.into(),
      version: "".into(),
      modes: vec![
        mode("clean",    "Clean",     if has_flutter {"flutter clean".into()} else {"dart clean".into()}),
        mode("pubget",   "Pub get",   "flutter pub get".into()),
        mode("build",    "Compilar",  if has_flutter {"flutter build".into()} else {"dart compile".into()}),
        mode("rebuild",  "Rebuild",   if has_flutter {"flutter clean && flutter build".into()} else {"dart clean && dart compile".into()}),
        mode("run",      "Ejecutar",  if has_flutter {"flutter run".into()} else {"dart run".into()}),
        mode("test",     "Test",      if has_flutter {"flutter test".into()} else {"dart test".into()}),
        mode("analyze",  "Analyze",   "flutter analyze".into()),
        mode("format",   "Format",    "dart format .".into()),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: if has_flutter {"flutter build".into()} else {"dart compile".into()},
      clean_cmd: if has_flutter {"flutter clean".into()} else {"dart clean".into()},
      run_cmd: if has_flutter {"flutter run".into()} else {"dart run".into()},
      test_cmd: if has_flutter {"flutter test".into()} else {"dart test".into()},
    });
  }

  // ─── DENO ───
  if p.join("deno.json").exists() || p.join("deno.jsonc").exists() || p.join("deno.lock").exists() {
    let entry = find_file(&p, "main.ts").or_else(|| find_file(&p, "main.js")).or_else(|| find_file(&p, "mod.ts")).unwrap_or_else(|| "main.ts".into());
    return ok(ProjectInfo {
      path, typ: "deno".into(), label: "Deno".into(), emoji: "🦕".into(), color: "#70ffaf".into(), version: "".into(),
      modes: vec![
        mode("check",   "Check",   "deno check".into()),
        mode("run",     "Run",     format!("deno run {}", entry)),
        mode("test",    "Test",    "deno test".into()),
        mode("lint",    "Lint",    "deno lint".into()),
        mode("fmt",     "Format",  "deno fmt".into()),
        mode("compile", "Compile", format!("deno compile {}", entry)),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: format!("deno check {}", entry), clean_cmd: "".into(),
      run_cmd: format!("deno run {}", entry), test_cmd: "deno test".into(),
    });
  }

  // ─── BUN ───
  if p.join("bun.lock").exists() || p.join("bun.lockb").exists() {
    let pkg = std::fs::read_to_string(p.join("package.json")).unwrap_or_default();
    let scripts = extract_npm_scripts(&pkg);
    let mut modes = vec![
      mode("install",  "Instalar", "bun install".into()),
      mode("build",    "Build",    "bun run build".into()),
      mode("run",      "Run",      "bun run dev".into()),
      mode("test",     "Test",     "bun test".into()),
      mode("lint",     "Lint",     "bun run lint".into()),
      mode("format",   "Format",   "bun run format".into()),
    ];
    if scripts.contains_key("start") {
      modes.push(mode("start", "Start", "bun start".into()));
    }
    if scripts.contains_key("typecheck") {
      modes.push(mode("typecheck","Typecheck","bun run typecheck".into()));
    }
    return ok(ProjectInfo {
      path, typ: "bun".into(), label: "Bun".into(), emoji: "🥟".into(), color: "#fbf0df".into(), version: "".into(),
      modes, profiles: vec![], gradle_tasks: vec![],
      build_cmd: "bun run build".into(), clean_cmd: "".into(),
      run_cmd: scripts.get("start").map(|c| format!("bun {}", c)).unwrap_or_else(|| "bun run dev".into()),
      test_cmd: "bun test".into(),
    });
  }

  // ─── NIM ───
  if find_file(&p, "*.nimble").is_some() || p.join("nim.cfg").exists() {
    return ok(ProjectInfo {
      path, typ: "nim".into(), label: "Nim".into(), emoji: "🟡".into(), color: "#f3d400".into(), version: "".into(),
      modes: vec![
        mode("compile", "Compilar", "nim compile src/main.nim".into()),
        mode("run",     "Ejecutar", "nim run src/main.nim".into()),
        mode("test",    "Test",     "nim test".into()),
        mode("clean",   "Clean",    "nim clean".into()),
        mode("rebuild", "Rebuild",  "nim clean && nim compile src/main.nim".into()),
        mode("cpp",     "C++",      "nim cpp src/main.nim".into()),
        mode("doc",     "Doc",      "nim doc src/main.nim".into()),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: "nim compile src/main.nim".into(), clean_cmd: "nim clean".into(),
      run_cmd: "nim run src/main.nim".into(), test_cmd: "nim test".into(),
    });
  }

  // ─── ZIG ───
  if p.join("build.zig").exists() {
    return ok(ProjectInfo {
      path, typ: "zig".into(), label: "Zig".into(), emoji: "⚡".into(), color: "#f7a41d".into(), version: "".into(),
      modes: vec![
        mode("build",   "Build",    "zig build".into()),
        mode("clean",   "Clean",    "zig build clean".into()),
        mode("rebuild", "Rebuild",  "zig build clean && zig build".into()),
        mode("run",     "Run",      "zig build run".into()),
        mode("test",    "Test",     "zig build test".into()),
        mode("fmt",     "Format",   "zig fmt .".into()),
        mode("exe",     "Build exe","zig build-exe src/main.zig".into()),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: "zig build".into(), clean_cmd: "zig build clean".into(),
      run_cmd: "zig build run".into(), test_cmd: "zig build test".into(),
    });
  }

  // ─── V ───
  if p.join("v.mod").exists() || find_file(&p, "vpkg.json").is_some() {
    return ok(ProjectInfo {
      path, typ: "v".into(), label: "V".into(), emoji: "🔮".into(), color: "#5d87bf".into(), version: "".into(),
      modes: vec![
        mode("build",   "Build",    "v build .".into()),
        mode("clean",   "Clean",    "v clean".into()),
        mode("rebuild", "Rebuild",  "v clean && v build .".into()),
        mode("run",     "Run",      "v run .".into()),
        mode("test",    "Test",     "v test .".into()),
        mode("fmt",     "Format",   "v fmt -w .".into()),
        mode("doc",     "Doc",      "v doc .".into()),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: "v build .".into(), clean_cmd: "v clean".into(),
      run_cmd: "v run .".into(), test_cmd: "v test .".into(),
    });
  }

  // ─── DOCKER ───
  if p.join("Dockerfile").exists() || p.join("docker-compose.yml").exists() || p.join("compose.yaml").exists() {
    let has_compose = p.join("docker-compose.yml").exists() || p.join("compose.yaml").exists();
    let mut modes = vec![
      mode("build",     "Build",     if has_compose {"docker compose build".into()} else {"docker build -t app .".into()}),
      mode("rebuild",   "Rebuild",   if has_compose {"docker compose build --no-cache".into()} else {"docker build --no-cache -t app .".into()}),
      mode("clean",     "Clean",     if has_compose {"docker compose down -v".into()} else {"docker system prune -f".into()}),
      mode("logs",      "Logs",      "docker compose logs -f".into()),
      mode("exec",      "Exec",      "docker compose exec app sh".into()),
      mode("push",      "Push",      "docker compose push".into()),
    ];
    if has_compose {
      modes.push(mode("up",      "Up",        "docker compose up".into()));
      modes.push(mode("up.d",    "Up -d",     "docker compose up -d".into()));
      modes.push(mode("down",    "Down",      "docker compose down".into()));
    }
    return ok(ProjectInfo {
      path, typ: "docker".into(), label: "Docker".into(), emoji: "🐳".into(), color: "#2496ed".into(), version: "".into(),
      modes, profiles: vec![], gradle_tasks: vec![],
      build_cmd: if has_compose {"docker compose build".into()} else {"docker build -t app .".into()},
      clean_cmd: if has_compose {"docker compose down -v".into()} else {"docker system prune -f".into()},
      run_cmd: if has_compose {"docker compose up".into()} else {"docker run app".into()},
      test_cmd: "".into(),
    });
  }

  // ─── XCODE / SWIFT ───
  if p.join("Package.swift").exists() {
    return ok(ProjectInfo {
      path, typ: "swift".into(), label: "Swift".into(), emoji: "🟧".into(), color: "#f05138".into(), version: "".into(),
      modes: vec![
        mode("build",   "Build",    "swift build".into()),
        mode("clean",   "Clean",    "swift package clean".into()),
        mode("rebuild", "Rebuild",  "swift package clean && swift build".into()),
        mode("run",     "Run",      "swift run".into()),
        mode("test",    "Test",     "swift test".into()),
        mode("format",  "Format",   "swift format .".into()),
        mode("release", "Release",  "swift build -c release".into()),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: "swift build".into(), clean_cmd: "swift package clean".into(),
      run_cmd: "swift run".into(), test_cmd: "swift test".into(),
    });
  }

  // ─── XCODEPROJ (Xcode legacy) ───
  let xcode_proj = find_file(&p, "*.xcodeproj");
  if let Some(proj) = xcode_proj {
    let proj_name = proj.trim_end_matches(".xcodeproj");
    return ok(ProjectInfo {
      path, typ: "xcode".into(), label: "Xcode".into(), emoji: "🛠️".into(), color: "#147efb".into(), version: "".into(),
      modes: vec![
        mode("build",   "Build",   format!("xcodebuild -project {} -scheme {} build", proj, proj_name)),
        mode("clean",   "Clean",   format!("xcodebuild -project {} -scheme {} clean", proj, proj_name)),
        mode("rebuild", "Rebuild", format!("xcodebuild -project {} -scheme {} clean build", proj, proj_name)),
        mode("test",    "Test",    format!("xcodebuild -project {} -scheme {} test", proj, proj_name)),
        mode("archive", "Archive", format!("xcodebuild -project {} -scheme {} archive", proj, proj_name)),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: format!("xcodebuild -project {} build", proj),
      clean_cmd: format!("xcodebuild -project {} clean", proj),
      run_cmd: format!("open {}.app", proj_name),
      test_cmd: format!("xcodebuild -project {} test", proj),
    });
  }

  // ─── RUBY / RAILS ───
  if p.join("Gemfile").exists() || p.join("Rakefile").exists() || find_file(&p, "*.rb").is_some() {
    let has_rails = std::fs::read_to_string(p.join("Gemfile")).unwrap_or_default().contains("rails");
    let mut modes = vec![
      mode("install",  "Bundle",       "bundle install".into()),
      mode("exec",     "Bundle exec",  "bundle exec ruby main.rb".into()),
      mode("test",     "RSpec",        "bundle exec rspec".into()),
      mode("lint",     "Rubocop",      "bundle exec rubocop".into()),
      mode("console",  "Console",      "bundle exec irb".into()),
    ];
    if has_rails {
      modes.push(mode("rails.s",  "Rails server",  "bundle exec rails server".into()));
      modes.push(mode("rails.c",  "Rails console", "bundle exec rails console".into()));
      modes.push(mode("rails.g",  "Rails generate","bundle exec rails generate".into()));
      modes.push(mode("rails.dbt", "DB migrate",   "bundle exec rails db:migrate".into()));
      modes.push(mode("rails.dbr", "DB rollback",  "bundle exec rails db:rollback".into()));
      modes.push(mode("rails.dbs", "DB seed",      "bundle exec rails db:seed".into()));
      modes.push(mode("routes",   "Routes",        "bundle exec rails routes".into()));
      modes.push(mode("assets",   "Assets precompile","bundle exec rails assets:precompile".into()));
    }
    return ok(ProjectInfo {
      path, typ: "ruby".into(), label: if has_rails {"Ruby on Rails"} else {"Ruby"}.into(),
      emoji: "💎".into(), color: "#cc342d".into(), version: "".into(),
      modes, profiles: vec![], gradle_tasks: vec![],
      build_cmd: "bundle install".into(), clean_cmd: "".into(),
      run_cmd: if has_rails {"bundle exec rails server".into()} else {"bundle exec ruby main.rb".into()},
      test_cmd: "bundle exec rspec".into(),
    });
  }

  // ─── PHP (Composer) ───
  if p.join("composer.json").exists() || find_file(&p, "*.php").is_some() {
    let mut modes = vec![
      mode("install",  "Composer install","composer install".into()),
      mode("update",   "Composer update", "composer update".into()),
      mode("test",     "PHPUnit",         "vendor/bin/phpunit".into()),
      mode("lint",     "PHP lint",        "php -l src/".into()),
      mode("server",   "PHP server",      "php -S localhost:8000 -t public".into()),
      mode("csfix",    "PHP CS Fixer",    "vendor/bin/php-cs-fixer fix".into()),
      mode("stan",     "PHPStan",         "vendor/bin/phpstan analyse".into()),
      mode("rebuild",  "Rebuild",         "composer install --no-cache".into()),
    ];
    if p.join("artisan").exists() {
      modes.push(mode("artisan",  "Artisan",        "php artisan".into()));
      modes.push(mode("migrate",  "Artisan migrate","php artisan migrate".into()));
      modes.push(mode("tinker",   "Artisan tinker", "php artisan tinker".into()));
    }
    return ok(ProjectInfo {
      path, typ: "php".into(), label: "PHP".into(), emoji: "🐘".into(), color: "#777bb3".into(), version: "".into(),
      modes, profiles: vec![], gradle_tasks: vec![],
      build_cmd: "composer install".into(), clean_cmd: "".into(),
      run_cmd: if p.join("artisan").exists() {"php artisan serve".into()} else {"php -S localhost:8000 -t public".into()},
      test_cmd: "vendor/bin/phpunit".into(),
    });
  }

  // ─── ERLANG (rebar3) ───
  if p.join("rebar.config").exists() || p.join("rebar.lock").exists() || find_file(&p, "*.erl").is_some() {
    return ok(ProjectInfo {
      path, typ: "erlang".into(), label: "Erlang".into(), emoji: "🔴".into(), color: "#a2003e".into(), version: "".into(),
      modes: vec![
        mode("compile",  "Compile",   "rebar3 compile".into()),
        mode("clean",    "Clean",     "rebar3 clean".into()),
        mode("rebuild",  "Rebuild",   "rebar3 clean && rebar3 compile".into()),
        mode("test",     "EUnit",     "rebar3 eunit".into()),
        mode("ct",       "Common Test","rebar3 ct".into()),
        mode("shell",    "Shell",     "rebar3 shell".into()),
        mode("release",  "Release",   "rebar3 release".into()),
        mode("dialyzer", "Dialyzer",  "rebar3 dialyzer".into()),
        mode("doc",      "EDoc",      "rebar3 edoc".into()),
        mode("upgrade",  "Upgrade",   "rebar3 upgrade".into()),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: "rebar3 compile".into(), clean_cmd: "rebar3 clean".into(),
      run_cmd: "rebar3 shell".into(), test_cmd: "rebar3 eunit".into(),
    });
  }

  // ─── PERL ───
  if p.join("Makefile.PL").exists() || p.join("Build.PL").exists() || p.join("cpanfile").exists() || find_file(&p, "*.pm").is_some() {
    let has_makefile_pl = p.join("Makefile.PL").exists();
    let build_step = if has_makefile_pl { "perl Makefile.PL && make" } else { "perl Build.PL && ./Build" };
    return ok(ProjectInfo {
      path, typ: "perl".into(), label: "Perl".into(), emoji: "🐪".into(), color: "#39457e".into(), version: "".into(),
      modes: vec![
        mode("build",   "Build",    build_step.into()),
        mode("test",    "Test",     "make test".into()),
        mode("clean",   "Clean",    "make clean".into()),
        mode("rebuild", "Rebuild",  format!("make clean && {}", build_step)),
        mode("run",     "Run",      "perl -Ilib script/run.pl".into()),
        mode("prove",   "Prove",    "prove -lv t".into()),
        mode("cpan",    "CPAN deps","cpanm --installdeps .".into()),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: build_step.into(), clean_cmd: "make clean".into(),
      run_cmd: "perl -Ilib script/run.pl".into(), test_cmd: "make test".into(),
    });
  }

  // ─── JULIA ───
  if p.join("Project.toml").exists() || find_file(&p, "*.jl").is_some() {
    let _has_project = p.join("Project.toml").exists();
    return ok(ProjectInfo {
      path, typ: "julia".into(), label: "Julia".into(), emoji: "🟣".into(), color: "#4063d8".into(), version: "".into(),
      modes: vec![
        mode("test",    "Test",     "julia -e 'using Pkg; Pkg.test()'".into()),
        mode("build",   "Build",    "julia -e 'using Pkg; Pkg.build()'".into()),
        mode("run",     "Run",      "julia src/main.jl".into()),
        mode("format",  "Format",   "julia -e 'using JuliaFormatter; format(\".\")'".into()),
        mode("doc",     "Doc",      "julia -e 'using Pkg; Pkg.doc()'".into()),
        mode("clean",   "Clean",    "julia -e 'using Pkg; Pkg.rm(\"*\")'".into()),
        mode("update",  "Update",   "julia -e 'using Pkg; Pkg.update()'".into()),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: "julia -e 'using Pkg; Pkg.build()'".into(),
      clean_cmd: "julia -e 'using Pkg; Pkg.rm(\"*\")'".into(),
      run_cmd: "julia src/main.jl".into(),
      test_cmd: "julia -e 'using Pkg; Pkg.test()'".into(),
    });
  }

  // ─── CRYSTAL ───
  if p.join("shard.yml").exists() || find_file(&p, "*.cr").is_some() {
    return ok(ProjectInfo {
      path, typ: "crystal".into(), label: "Crystal".into(), emoji: "💎".into(), color: "#000000".into(), version: "".into(),
      modes: vec![
        mode("build",   "Build",     "crystal build src/main.cr".into()),
        mode("run",     "Ejecutar",  "crystal run src/main.cr".into()),
        mode("test",    "Spec",      "crystal spec".into()),
        mode("clean",   "Clean",     "crystal tool clean".into()),
        mode("rebuild", "Rebuild",   "crystal tool clean && crystal build src/main.cr".into()),
        mode("format",  "Format",    "crystal tool format".into()),
        mode("docs",    "Docs",      "crystal docs".into()),
        mode("deps",    "Shards",    "shards install".into()),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: "crystal build src/main.cr".into(), clean_cmd: "crystal tool clean".into(),
      run_cmd: "crystal run src/main.cr".into(), test_cmd: "crystal spec".into(),
    });
  }

  // ─── MESON ───
  if p.join("meson.build").exists() {
    return ok(ProjectInfo {
      path, typ: "meson".into(), label: "Meson".into(), emoji: "🔧".into(), color: "#53c1e3".into(), version: "".into(),
      modes: vec![
        mode("setup",   "Setup",     "meson setup build".into()),
        mode("build",   "Build",     "meson compile -C build".into()),
        mode("test",    "Test",      "meson test -C build".into()),
        mode("clean",   "Clean",     "meson compile -C build --clean".into()),
        mode("rebuild", "Rebuild",   "meson setup --wipe build && meson compile -C build".into()),
        mode("install", "Install",   "meson install -C build".into()),
        mode("fmt",     "Format",    "meson format".into()),
        mode("dist",    "Dist",      "meson dist -C build".into()),
      ],
      profiles: vec![], gradle_tasks: vec![],
      build_cmd: "meson compile -C build".into(), clean_cmd: "meson compile -C build --clean".into(),
      run_cmd: "meson compile -C build && ./build/app".into(), test_cmd: "meson test -C build".into(),
    });
  }

  Err("Tipo no reconocido. Coloca pom.xml / build.gradle / package.json / go.mod / Cargo.toml / CMakeLists.txt / *.java / BUILD / build.sbt / mix.exs / *.cabal / pubspec.yaml / Dockerfile / build.zig / Package.swift / v.mod / Gemfile / composer.json / rebar.config / Makefile.PL / Project.toml / shard.yml / meson.build".into())
}

fn inject_debug_args(cmd: &str, port: i32, suspend: bool) -> String {
  let s = if suspend { "y" } else { "n" };
  let jdwp = format!("-agentlib:jdwp=transport=dt_socket,server=y,suspend={},address={}", s, port);
  let t = cmd.trim();
  if !t.contains("java") && !t.contains("mvn") && !t.contains("gradle") {
    return cmd.to_string();
  }
  if t.starts_with("java ") || t.starts_with("java\t") {
    let rest = t.strip_prefix("java").unwrap().trim_start();
    format!("java {} {}", jdwp, rest)
  } else if t.starts_with("mvn") || t.starts_with("mvnw") {
    #[cfg(windows)] { format!("set MAVEN_OPTS={} && {}", jdwp, t) }
    #[cfg(not(windows))] { format!("MAVEN_OPTS='{}' {}", jdwp, t) }
  } else if t.starts_with("gradle") || t.starts_with("gradlew") {
    format!("{} --debug-jvm", t)
  } else {
    cmd.to_string()
  }
}

#[tauri::command]
async fn run_cmd(app: AppHandle, path: String, cmd: String, debug_port: Option<i32>, debug_suspend: Option<bool>) -> Result<(), String> {
  let cmd = if let Some(port) = debug_port.filter(|p| *p > 0) {
    let suspend = debug_suspend.unwrap_or(true);
    let dc = inject_debug_args(&cmd, port, suspend);
    let hint = if suspend { " (suspend=y — espera al debugger)" } else { " (suspend=n — arranca ya)" };
    emitl(&app, format!("🐛 JDWP debug on port {}{}", port, hint), "info");
    emitl(&app, format!("📎 Attach: jdb -attach localhost:{}", port), "dim");
    emitl(&app, "🔧 Para VS Code crear .vscode/launch.json con:".to_string(), "dim");
    emitl(&app, r#"{"type":"java","request":"attach","name":"ATL Debug","hostName":"localhost","port":<PORT>}"#.to_string(), "dim");
    dc
  } else { cmd };
  emitl(&app, format!("> {}", cmd), "info");
  emitl(&app, format!(">>> {}", path), "dim");

  let app_s = app.clone();
  let app_e = app.clone();
  let app_f = app;

  std::thread::spawn(move || {
    emitl(&app_f, "▶ iniciado".into(), "run-active");

    #[cfg(windows)]
    let spawn_child = || -> Option<std::process::Child> {
      let mut b = hid_cmd("cmd");
      b.args(["/C", &cmd]).current_dir(&path)
        .stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
      b.spawn().ok().or_else(|| {
        let parts: Vec<&str> = cmd.splitn(2, ' ').collect();
        let mut b2 = hid_cmd(parts[0]);
        if parts.len() > 1 { b2.args([parts[1]]); }
        b2.current_dir(&path).stdout(Stdio::piped()).stderr(Stdio::piped())
          .stdin(Stdio::null());
        b2.spawn().ok()
      })
    };

    #[cfg(not(windows))]
    let spawn_child = || -> Option<std::process::Child> {
      let parts: Vec<&str> = cmd.splitn(2, ' ').collect();
      let mut b = Command::new(parts[0]);
      if parts.len() > 1 { b.args([parts[1]]); }
      b.current_dir(&path).stdout(Stdio::piped()).stderr(Stdio::piped())
        .stdin(Stdio::null());
      b.spawn().ok().or_else(|| {
        let mut b2 = Command::new("sh");
        b2.args(["-c", &cmd]).current_dir(&path)
          .stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
        b2.spawn().ok()
      })
    };

    let Some(mut child) = spawn_child() else {
      emitl(&app_f, "error al iniciar".into(), "run-end");
      return;
    };
    CHILD_PIDS.lock().unwrap().insert(path.clone(), child.id());

    let out_h = child.stdout.take().map(|o| std::thread::spawn(move || drain(o, &app_s, "stdout")));
    let err_h = child.stderr.take().map(|e| std::thread::spawn(move || drain(e, &app_e, "stderr")));
    let Ok(st) = child.wait() else {
      CHILD_PIDS.lock().unwrap().remove(&path);
      emitl(&app_f, "error en ejecución".into(), "run-end");
      return;
    };
    if let Some(h) = out_h { h.join().ok(); }
    if let Some(h) = err_h { h.join().ok(); }
    CHILD_PIDS.lock().unwrap().remove(&path);
    let k = if st.success() {"ok"} else {"err"};
    let _ = app_f.emit("log", LogLine {
      text: if st.success() {"Completado.".into()} else {format!("exit {}", st.code().unwrap_or(-1))},
      kind: k.into()
    });
    let _ = app_f.emit("log", LogLine { text: "───".into(), kind: "done".into() });
    emitl(&app_f, "".into(), "run-end");
  });

  Ok(())
}

#[tauri::command]
fn stop_cmd(path: String) -> Result<(), String> {
  let pid = CHILD_PIDS.lock().unwrap().remove(&path);
  match pid {
    None => Err("No hay comando en ejecución".into()),
    Some(pid) => {
      eprintln!("[DEBUG] stop_cmd: killing PID={}", pid);
      #[cfg(windows)]
      let r = Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).creation_flags(HIDDEN_PROCESS).output();
      #[cfg(not(windows))]
      let r = Command::new("kill").args(["-9", &pid.to_string()]).output();
      match r {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Error al cancelar: {}", e)),
      }
    }
  }
}

#[tauri::command]
fn suspend_cmd(path: String) -> Result<(), String> {
  let map = CHILD_PIDS.lock().unwrap();
  let pid = map.get(&path).copied();
  match pid {
    None => Err("No hay comando en ejecución".into()),
    Some(pid) => {
      #[cfg(windows)]
      let r = Command::new("taskkill").args(["/SUSPEND", "/PID", &pid.to_string()]).creation_flags(HIDDEN_PROCESS).output();
      #[cfg(not(windows))]
      let r = Command::new("kill").args(["-SIGSTOP", &pid.to_string()]).output();
      r.map_err(|e| format!("Error al pausar: {}", e)).map(|_| ())
    }
  }
}

#[tauri::command]
fn resume_cmd(path: String) -> Result<(), String> {
  let map = CHILD_PIDS.lock().unwrap();
  let pid = map.get(&path).copied();
  match pid {
    None => Err("No hay comando en ejecución".into()),
    Some(pid) => {
      #[cfg(windows)]
      let r = Command::new("taskkill").args(["/RESUME", "/PID", &pid.to_string()]).creation_flags(HIDDEN_PROCESS).output();
      #[cfg(not(windows))]
      let r = Command::new("kill").args(["-SIGCONT", &pid.to_string()]).output();
      r.map_err(|e| format!("Error al reanudar: {}", e)).map(|_| ())
    }
  }
}

// ══════════════════════════════════════════════════
//  TERMINAL — pipe-based (each tab gets isolated pipes)
// ══════════════════════════════════════════════════

#[cfg(windows)]
fn shell_program() -> &'static str { "pwsh.exe" }
#[cfg(not(windows))]
fn shell_program() -> &'static str { "bash" }

fn start_reader_thread<R: Read + Send + 'static>(mut reader: R, app: AppHandle, id: String, emit_exit: bool) {
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut first = true;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    debug_log(&format!("reader[{}]: EOF", id));
                    break;
                }
                Err(e) => {
                    debug_log(&format!("reader[{}]: error: {:?}", id, e));
                    break;
                }
                Ok(n) => {
                    if first {
                        let preview = String::from_utf8_lossy(&buf[..n.min(200)]);
                        debug_log(&format!("reader[{}]: FIRST read: {} bytes, preview={:?}", id, n, preview));
                        first = false;
                    }
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit("terminal-output", serde_json::json!({
                        "id": id,
                        "data": data
                    }));
                }
            }
        }
        if emit_exit {
            let _ = app.emit("terminal-exited", serde_json::json!({ "id": id }));
        }
        debug_log(&format!("reader[{}]: thread exiting", id));
    });
}

#[cfg(windows)]
fn spawn_portable_pty(dir: &std::path::Path, app: &AppHandle, id: &str, cols: u16, rows: u16) -> Result<(TerminalSession, bool), String> {
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows, cols,
        pixel_width: 0, pixel_height: 0,
    }).map_err(|e| format!("spawn_portable_pty: openpty failed: {}", e))?;

    let mut cmd = CommandBuilder::new(shell_program());
    cmd.cwd(dir);
    cmd.arg("-NoLogo");
    cmd.env("TERM", "xterm-256color");
    let child = pair.slave.spawn_command(cmd)
        .map_err(|e| format!("spawn_portable_pty: spawn_command failed: {}", e))?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader()
        .map_err(|e| format!("spawn_portable_pty: try_clone_reader failed: {}", e))?;
    let writer = pair.master.take_writer()
        .map_err(|e| format!("spawn_portable_pty: take_writer failed: {}", e))?;

    let pid = child.process_id();
    debug_log(&format!("spawn_portable_pty: OK pid={:?}", pid));

    let app_clone = app.clone();
    let id_string = id.to_string();
    thread::spawn(move || {
        portable_pty_reader(reader, app_clone, &id_string);
    });

    Ok((
        TerminalSession {
            backend: TerminalBackend::PortablePty {
                master: pair.master,
                child,
                writer,
            },
        },
        true,
    ))
}

#[cfg(windows)]
fn portable_pty_reader(mut reader: Box<dyn std::io::Read + Send>, app: AppHandle, id: &str) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut buf = vec![0u8; 8192];
        let mut first = true;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    debug_log(&format!("portable_pty_reader[{}]: EOF", id));
                    break;
                }
                Ok(n) => {
                    if first {
                        debug_log(&format!("portable_pty_reader[{}]: FIRST read: {} bytes", id, n));
                        first = false;
                    }
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    if let Err(e) = app.emit("terminal-output", serde_json::json!({
                        "id": id,
                        "data": text,
                    })) {
                        debug_log(&format!("portable_pty_reader[{}] emit error: {:?}", id, e));
                        break;
                    }
                }
                Err(e) => {
                    debug_log(&format!("portable_pty_reader[{}] read error: {:?}", id, e));
                    break;
                }
            }
        }
        let _ = app.emit("terminal-exited", serde_json::json!({ "id": id }));
    }));
    if let Err(panic) = result {
        let msg = if let Some(s) = panic.downcast_ref::<&str>() {
            format!("portable_pty_reader[{}] panic: {}", id, s)
        } else if let Some(s) = panic.downcast_ref::<String>() {
            format!("portable_pty_reader[{}] panic: {}", id, s)
        } else {
            format!("portable_pty_reader[{}] panic: unknown", id)
        };
        debug_log(&msg);
    }
    debug_log(&format!("portable_pty_reader[{}]: done", id));
}

#[cfg(windows)]
#[allow(dead_code)]
fn start_console_poller(handle: SendHandle, child_handle: SendHandle, app: AppHandle, id: String) {
    use std::time::Duration;
    thread::spawn(move || {
        let h = handle.to_h();
        let ch = child_handle.to_h();
        unsafe {
            let mut prev_key: Vec<u8> = Vec::new();
            let mut prev_vt = String::new();
            let poll_interval = Duration::from_millis(80);

            loop {
                thread::sleep(poll_interval);

                if WaitForSingleObject(ch, 0) == WAIT_OBJECT_0 {
                    debug_log(&format!("cpoller[{}]: child exited", id));
                    break;
                }

                let mut info = CONSOLE_SCREEN_BUFFER_INFO::default();
                if GetConsoleScreenBufferInfo(h, &mut info).is_err() {
                    debug_log(&format!("cpoller[{}]: console gone, exiting", id));
                    break;
                }

                // Use the visible window (srWindow) instead of the entire
                // scrollback buffer (dwSize) to keep reads fast and small.
                let win = info.srWindow;
                let width = (win.Right - win.Left + 1).max(0) as i16;
                let height = (win.Bottom - win.Top + 1).max(0) as i16;
                if width <= 0 || height <= 0 {
                    debug_log(&format!("cpoller[{}]: window size {width}x{height} -> skip", id));
                    continue;
                }

                let total = (width * height) as usize;

                // Read characters with proven-working API
                let mut chars_buf: Vec<u16> = vec![0u16; total];
                let mut chars_read: u32 = 0;
                if ReadConsoleOutputCharacterW(
                    h,
                    &mut chars_buf,
                    COORD { X: win.Left, Y: win.Top },
                    &mut chars_read,
                ).is_err() {
                    continue;
                }

                // Read attributes per row using ReadConsoleOutputAttribute
                let mut attrs_buf: Vec<u16> = vec![0u16; width as usize];
                let mut row_attrs: Vec<u16> = Vec::with_capacity(total);
                let mut attrs_read: u32 = 0;

                for row in 0..height {
                    let coord = COORD { X: win.Left, Y: win.Top + row };
                    if ReadConsoleOutputAttribute(
                        h,
                        &mut attrs_buf,
                        coord,
                        &mut attrs_read,
                    ).is_ok() {
                        row_attrs.extend_from_slice(&attrs_buf[..attrs_read as usize]);
                    } else {
                        for _ in 0..width {
                            row_attrs.push(0x07);
                        }
                    }
                }

                // Quick comparison to skip identical frames
                let raw_key: Vec<u8> = chars_buf.iter().chain(row_attrs.iter()).map(|&v| {
                    [v as u8, (v >> 8) as u8]
                }).flatten().collect();

                if prev_key.len() == raw_key.len() && prev_key == raw_key {
                    continue;
                }

                // Find effective content height: last non-empty row, or cursor row,
                // so we never output more rows than needed.
                let cursor = info.dwCursorPosition;
                let cursor_row_idx = (cursor.Y - win.Top) as usize;
                let mut content_h = (cursor_row_idx + 1).max(1).min(height as usize);
                for row in (0..height as usize).rev() {
                    let start = row * width as usize;
                    let end = start + width as usize;
                    if chars_buf[start..end].iter().any(|&c| c != 0 && c != ' ' as u16) {
                        content_h = content_h.max(row + 1);
                        break;
                    }
                }
                let content_height = content_h.min(height as usize) as i16;

                // Generate VT text only for the content rows
                let vt = buffer_to_vt2(&chars_buf, &row_attrs, width, content_height);

                if vt == prev_vt {
                    prev_key = raw_key;
                    continue;
                }

                // Read cursor position relative to visible window
                let cursor_row = (cursor_row_idx + 1).max(1).min(content_height as usize) as u16;
                let cursor_col = (cursor.X - win.Left + 1).max(1).min(width) as u16;
                let cursor_seq = format!("\x1b[{};{}H", cursor_row, cursor_col);
                debug_log(&format!("cpoller[{}]: cursor Y={} X={} win.Top={} win.Left={} row={} col={} vt_len={} content_h={}", id, cursor.Y, cursor.X, win.Top, win.Left, cursor_row, cursor_col, vt.len(), content_height));

                    if prev_vt.is_empty() || !vt.starts_with(&prev_vt) {
                        // Full refresh — move home, write content, clear each row tail, clear below, position cursor.
                        let display_vt = vt.replace("\r\n", "\x1b[K\r\n");
                        let _ = app.emit("terminal-output", serde_json::json!({
                            "id": id,
                            "data": format!("\x1b[H{}{}{}", display_vt, "\x1b[J", cursor_seq)
                        }));
                } else {
                    // Content appended/same — send only the new part + cursor sync
                    let delta = &vt[prev_vt.len()..];
                    if !delta.is_empty() {
                        let _ = app.emit("terminal-output", serde_json::json!({
                            "id": id,
                            "data": format!("{}{}", delta, cursor_seq)
                        }));
                    } else if prev_vt == vt {
                        // Content unchanged but cursor may have moved — just send cursor position
                        let _ = app.emit("terminal-output", serde_json::json!({
                            "id": id,
                            "data": cursor_seq
                        }));
                    }
                }

                prev_vt = vt;
                prev_key = raw_key;
            }

            let _ = app.emit("terminal-exited", serde_json::json!({ "id": id }));
            debug_log(&format!("cpoller[{}]: thread exiting", id));
        }
    });
}

#[cfg(windows)]
fn buffer_to_vt2(chars: &[u16], attrs: &[u16], width: i16, height: i16) -> String {
    const WIN_TO_ANSI: [u8; 8] = [0, 4, 2, 6, 1, 5, 3, 7];
    let w = width as usize;
    let mut out = String::new();
    let h = height as usize;

    for row in 0..h {
        let start = row * w;
        let end = start + w;
        let chr = &chars[start..end];
        let atr = &attrs[start..end];

        let trim = chr.iter()
            .rposition(|&c| c != 0 && c != ' ' as u16)
            .map(|p| p + 1)
            .unwrap_or(0);

        let mut row_started = false;

        for i in 0..trim {
            let attr = atr[i];
            let ch = chr[i];
            let fg = attr & 0x0F;
            let bg = (attr >> 4) & 0x0F;

            if !row_started {
                // Emit attribute for first non-empty cell of this row
                if fg == 0x07 && bg == 0x00 {
                    out.push_str("\x1b[0m");
                } else {
                    let mut codes = vec!["0".to_string()];
                    let ansi_fg = WIN_TO_ANSI[(fg & 0x07) as usize];
                    if fg & 0x08 != 0 {
                        codes.push(format!("{}", 90 + ansi_fg));
                    } else if fg & 0x07 != 0x07 {
                        codes.push(format!("{}", 30 + ansi_fg));
                    }
                    let ansi_bg = WIN_TO_ANSI[(bg & 0x07) as usize];
                    if bg & 0x08 != 0 {
                        codes.push(format!("{}", 100 + ansi_bg));
                    } else if bg & 0x07 != 0 {
                        codes.push(format!("{}", 40 + ansi_bg));
                    }
                    out.push_str(&format!("\x1b[{}m", codes.join(";")));
                }
                row_started = true;
            }

            if ch == 0 {
                out.push(' ');
            } else {
                out.push(char::from_u32(ch as u32).unwrap_or('?'));
            }
        }

        out.push_str("\r\n");
    }

    out
}

#[tauri::command]
fn start_terminal(app: AppHandle, path: String, initial_cmd: Option<String>, _shell: Option<String>, cols: Option<u16>, rows: Option<u16>) -> Result<TerminalStartResult, String> {
    let id = NEXT_TERM_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed).to_string();
    let dir = if path.is_empty() {
        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
    } else {
        std::path::PathBuf::from(&path)
    };
    debug_log(&format!("start_terminal: dir={:?}", dir));

    #[cfg(windows)]
    let (session, has_tty) = {
        init_hidden_console();
        let term_cols = cols.unwrap_or(120);
        let term_rows = rows.unwrap_or(30);
        match spawn_portable_pty(&dir, &app, &id, term_cols, term_rows) {
            Ok(result) => {
                debug_log("start_terminal: using portable-pty backend");
                result
            }
            Err(e) => {
                debug_log(&format!("start_terminal: portable-pty failed ({}), trying winpty", e));
                try_winpty_or_pipe(&app, dir.to_str().unwrap_or("."), &id)?
            }
        }
    };
    #[cfg(not(windows))]
    let (session, has_tty) = fallback_pipe_session(dir.to_str().unwrap_or("."), &app, &id)?;

    app.state::<Mutex<HashMap<String, TerminalSession>>>()
        .lock().map_err(|e| e.to_string())?
        .insert(id.clone(), session);

    if let Ok(mut map) = app.state::<Mutex<HashMap<String, TerminalSession>>>().lock() {
        if let Some(s) = map.get_mut(&id) {
            if let Some(cmd) = initial_cmd {
                let _ = s.write_stdin(format!("{}\r\n", cmd).as_bytes());
                let _ = s.flush_stdin();
            } else if !path.is_empty() {
                let _ = s.write_stdin(format!("cd \"{}\"\r\n", path).as_bytes());
                let _ = s.flush_stdin();
            }
        }
    }

    Ok(TerminalStartResult { id, has_tty })
}

#[cfg(windows)]
fn spawn_winpty_session(winpty: &std::path::Path, dir: &str, app: &AppHandle, id: &str) -> Result<(TerminalSession, bool), String> {
    debug_log("spawn_winpty_session: starting PowerShell via winpty");
    // Look for msys-2.0.dll (bundled with Git for Windows) and add to PATH
    let msys_paths = [
        r"C:\Program Files\Git\usr\bin",
        r"C:\Program Files (x86)\Git\usr\bin",
        r"C:\msys64\usr\bin",
    ];
    let mut extra_path = String::new();
    for p in &msys_paths {
        let dll = std::path::Path::new(p).join("msys-2.0.dll");
        if dll.exists() {
            extra_path = format!("{};", p);
            break;
        }
    }
    let mut cmd = Command::new(winpty);
    cmd.creation_flags(HIDDEN_PROCESS)
        .arg(shell_program())
        .arg("-NoLogo")
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !extra_path.is_empty() {
        // Prepend the msys bin dir to PATH for the child process
        if let Ok(current) = std::env::var("PATH") {
            let new_path = format!("{}{}", extra_path, current);
            cmd.env("PATH", new_path);
        }
    }
    let mut child = cmd.spawn()
        .map_err(|e| {
            let msg = format!("Failed to start winpty session: {}", e);
            debug_log(&msg);
            msg
        })?;

    debug_log(&format!("spawn_winpty_session: child spawned OK, pid={}", child.id()));

    let stdin = child.stdin.take().ok_or_else(|| { debug_log("No stdin"); "No stdin".to_string() })?;
    let stdout = child.stdout.take().ok_or_else(|| { debug_log("No stdout"); "No stdout".to_string() })?;
    let stderr = child.stderr.take().ok_or_else(|| { debug_log("No stderr"); "No stderr".to_string() })?;

    debug_log("spawn_winpty_session: starting reader threads");
    start_reader_thread(stdout, app.clone(), id.to_string(), true);
    start_reader_thread(stderr, app.clone(), id.to_string(), false);
    debug_log("spawn_winpty_session: reader threads started");

    // winpty provides a real TTY to child processes
    Ok((TerminalSession { backend: TerminalBackend::Process { child, stdin } }, true))
}

fn fallback_pipe_session(dir: &str, app: &AppHandle, id: &str) -> Result<(TerminalSession, bool), String> {
    debug_log("fallback_pipe_session: starting PowerShell with pipes");
    let mut child = hid_cmd(shell_program())
        .arg("-NoProfile")
        .arg("-Command")
        .arg("-")
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            let msg = format!("Failed to start shell: {}", e);
            debug_log(&msg);
            msg
        })?;

    debug_log(&format!("fallback_pipe_session: child spawned OK, pid={}", child.id()));

    let stdin = child.stdin.take().ok_or_else(|| { debug_log("No stdin"); "No stdin".to_string() })?;
    let stdout = child.stdout.take().ok_or_else(|| { debug_log("No stdout"); "No stdout".to_string() })?;
    let stderr = child.stderr.take().ok_or_else(|| { debug_log("No stderr"); "No stderr".to_string() })?;

    debug_log("fallback_pipe_session: starting reader threads");
    start_reader_thread(stdout, app.clone(), id.to_string(), true);
    start_reader_thread(stderr, app.clone(), id.to_string(), false);
    debug_log("fallback_pipe_session: reader threads started");

    Ok((TerminalSession { backend: TerminalBackend::Process { child, stdin } }, false))
}

#[tauri::command]
fn set_terminal_size(session_id: String, cols: u16, rows: u16,
    sessions: tauri::State<'_, Mutex<HashMap<String, TerminalSession>>>) -> Result<(), String>
{
    #[cfg(windows)]
    if let Ok(map) = sessions.lock() {
        if let Some(s) = map.get(&session_id) {
            if let TerminalBackend::PortablePty { master, .. } = &s.backend {
                let _ = master.resize(portable_pty::PtySize {
                    rows, cols,
                    pixel_width: 0, pixel_height: 0,
                });
                debug_log(&format!("set_terminal_size portable-pty[{}]: {}x{}", session_id, cols, rows));
                return Ok(());
            }
        }
    }
    // Pipe-based backends don't need buffer resize
    debug_log(&format!("set_terminal_size[{}]: {}x{} (pipe, ignored)", session_id, cols, rows));
    Ok(())
}

#[tauri::command]
fn write_terminal(session_id: String, data: String,
    sessions: tauri::State<'_, Mutex<HashMap<String, TerminalSession>>>) -> Result<(), String>
{
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut map = sessions.lock().map_err(|e| e.to_string())?;
        let session = map.get_mut(&session_id).ok_or("Session not found")?;
        session.write_stdin(data.as_bytes()).map_err(|e| format!("Write error: {}", e))?;
        session.flush_stdin().map_err(|e| format!("Flush error: {}", e))?;
        Ok::<(), String>(())
    }));
    match result {
        Ok(r) => r,
        Err(panic) => {
            let msg = if let Some(s) = panic.downcast_ref::<&str>() {
                format!("panic in write_terminal: {}", s)
            } else if let Some(s) = panic.downcast_ref::<String>() {
                format!("panic in write_terminal: {}", s)
            } else {
                "panic in write_terminal: unknown".into()
            };
            debug_log(&msg);
            Err(msg)
        }
    }
}

#[tauri::command]
fn stop_terminal(session_id: String,
    sessions: tauri::State<'_, Mutex<HashMap<String, TerminalSession>>>) -> Result<(), String>
{
    let mut map = sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut s) = map.remove(&session_id) {
        s.kill();
        Ok(())
    } else {
        Err("Session not found".into())
    }
}

#[cfg(windows)]
fn try_winpty_or_pipe(app: &AppHandle, dir: &str, id: &str) -> Result<(TerminalSession, bool), String> {
    if let Some(winpty) = winpty_path(app) {
        match spawn_winpty_session(&winpty, dir, app, id) {
            Ok(result) => {
                debug_log("start_terminal: using winpty backend (TTY enabled)");
                return Ok(result);
            }
            Err(e2) => {
                debug_log(&format!("start_terminal: winpty also failed ({}), using pipes", e2));
            }
        }
    } else {
        debug_log("start_terminal: winpty not found, using pipes");
    }
    fallback_pipe_session(dir, app, id)
}

#[cfg(windows)]
fn winpty_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    // Strategy 1: resource directory (production bundle)
    if let Ok(base) = app.path().resource_dir() {
        let p = base.join("binaries").join("winpty.exe");
        if p.exists() { return Some(p); }
    }
    // Strategy 2: next to the executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let p = parent.join("binaries").join("winpty.exe");
            if p.exists() { return Some(p); }
        }
    }
    // Strategy 3: current working directory (dev mode fallback)
    let p = PathBuf::from("binaries").join("winpty.exe");
    if p.exists() { return Some(p); }
    None
}

#[cfg(not(windows))]
fn winpty_path(_app: &AppHandle) -> Option<std::path::PathBuf> { None }

#[tauri::command]
fn launch_external_terminal(path: String, initial_cmd: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let full_cmd = format!("cmd.exe /K \"cd /d \"{}\" && {}\"", path, initial_cmd);
        Command::new("cmd")
            .args(["/C", "start", "ATL Terminal", &full_cmd])
            .creation_flags(HIDDEN_PROCESS)
            .spawn()
            .map_err(|e| format!("Failed to launch terminal: {}", e))?;
    }
    #[cfg(not(windows))]
    {
        Command::new("x-terminal-emulator")
            .arg("-e")
            .arg(format!("cd {} && {}", path, initial_cmd))
            .spawn()
            .map_err(|e| format!("Failed to launch terminal: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn git_pull(path: String) -> Result<String, String> {
  eprintln!("[DEBUG] git_pull: path={:?}", &path);
  let out = hid_cmd("git").args(["-C", &path, "pull"]).output().map_err(|e| format!("git: {}", e))?;
  let stdout = String::from_utf8(out.stdout).map_err(|_| "git: utf8 error".to_string())?;
  let stderr = String::from_utf8(out.stderr).map_err(|_| "git: utf8 error".to_string())?;
  if !out.status.success() { return Err(stderr.trim().to_string()); }
  Ok(stdout.trim().to_string())
}

#[tauri::command]
fn git_push(path: String) -> Result<String, String> {
  eprintln!("[DEBUG] git_push: path={:?}", &path);
  let out = hid_cmd("git").args(["-C", &path, "push"]).output().map_err(|e| format!("git: {}", e))?;
  let stdout = String::from_utf8(out.stdout).map_err(|_| "git: utf8 error".to_string())?;
  let stderr = String::from_utf8(out.stderr).map_err(|_| "git: utf8 error".to_string())?;
  if !out.status.success() { return Err(stderr.trim().to_string()); }
  Ok(stdout.trim().to_string())
}

#[tauri::command]
fn git_stash(path: String) -> Result<String, String> {
  eprintln!("[DEBUG] git_stash: path={:?}", &path);
  let out = hid_cmd("git").args(["-C", &path, "stash"]).output().map_err(|e| format!("git: {}", e))?;
  let stdout = String::from_utf8(out.stdout).map_err(|_| "git: utf8 error".to_string())?;
  let stderr = String::from_utf8(out.stderr).map_err(|_| "git: utf8 error".to_string())?;
  if !out.status.success() { return Err(stderr.trim().to_string()); }
  Ok(stdout.trim().to_string())
}

#[tauri::command]
fn git_stash_pop(path: String) -> Result<String, String> {
  eprintln!("[DEBUG] git_stash_pop: path={:?}", &path);
  let out = hid_cmd("git").args(["-C", &path, "stash", "pop"]).output().map_err(|e| format!("git: {}", e))?;
  let stdout = String::from_utf8(out.stdout).map_err(|_| "git: utf8 error".to_string())?;
  let stderr = String::from_utf8(out.stderr).map_err(|_| "git: utf8 error".to_string())?;
  if !out.status.success() { return Err(stderr.trim().to_string()); }
  Ok(stdout.trim().to_string())
}

#[tauri::command]
fn git_diff(path: String, file: String) -> Result<String, String> {
  eprintln!("[DEBUG] git_diff: path={:?} file={:?}", &path, &file);
  let out = hid_cmd("git").args(["-C", &path, "diff", "--", &file]).output().map_err(|e| format!("git: {}", e))?;
  let s = String::from_utf8(out.stdout).map_err(|_| "git: utf8 error".to_string())?;
  if s.is_empty() { return Ok("(no diff — archivo sin seguimiento o sin cambios)".into()); }
  Ok(s)
}

#[tauri::command]
fn git_fetch(path: String) -> Result<String, String> {
  eprintln!("[DEBUG] git_fetch: path={:?}", &path);
  let out = hid_cmd("git").args(["-C", &path, "fetch", "--all"]).output().map_err(|e| format!("git: {}", e))?;
  let stdout = String::from_utf8(out.stdout).map_err(|_| "git: utf8 error".to_string())?;
  let stderr = String::from_utf8(out.stderr).map_err(|_| "git: utf8 error".to_string())?;
  if !out.status.success() { return Err(stderr.trim().to_string()); }
  Ok(stdout.trim().to_string())
}

#[tauri::command]
fn git_add(path: String, file: String) -> Result<String, String> {
  eprintln!("[DEBUG] git_add: path={:?} file={:?}", &path, &file);
  let out = hid_cmd("git").args(["-C", &path, "add", "--", &file]).output().map_err(|e| format!("git add: {}", e))?;
  let stdout = String::from_utf8(out.stdout).map_err(|_| "git: utf8 error".to_string())?;
  let stderr = String::from_utf8(out.stderr).map_err(|_| "git: utf8 error".to_string())?;
  if !out.status.success() { return Err(stderr.trim().to_string()); }
  Ok(stdout.trim().to_string())
}

#[tauri::command]
fn git_commit(path: String, message: String) -> Result<String, String> {
  eprintln!("[DEBUG] git_commit: path={:?}", &path);
  let out = hid_cmd("git").args(["-C", &path, "commit", "-m", &message]).output().map_err(|e| format!("git commit: {}", e))?;
  let stdout = String::from_utf8(out.stdout).map_err(|_| "git: utf8 error".to_string())?;
  let stderr = String::from_utf8(out.stderr).map_err(|_| "git: utf8 error".to_string())?;
  if !out.status.success() { return Err(stderr.trim().to_string()); }
  Ok(stdout.trim().to_string())
}

#[tauri::command]
fn search_files(path: String, query: String) -> Result<Vec<String>, String> {
  eprintln!("[DEBUG] search_files: path={:?} query={:?}", &path, &query);
  if query.trim().is_empty() { return Ok(vec![]); }
  let out = hid_cmd("cmd")
    .args(["/C", &format!("dir /s /b /a-d \"{}*\"", query.replace('"', ""))])
    .current_dir(&path)
    .output().map_err(|e| format!("search: {}", e))?;
  let s = String::from_utf8(out.stdout).map_err(|_| "search: utf8 error".to_string())?;
  Ok(s.lines().filter_map(|l| {
    let l = l.trim();
    if l.is_empty() { return None; }
    let rel = l.strip_prefix(&path.replace('/', "\\")).or_else(|| l.strip_prefix(&path)).unwrap_or(l);
    Some(rel.trim_start_matches('\\').trim_start_matches('/').to_string())
  }).take(30).collect())
}

// ══════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════

fn ok<T: Serialize + Clone + std::fmt::Debug>(v: T) -> Result<T, String> {
  Ok(v)
}

fn mode(id: impl Into<String>, label: impl Into<String>, cmd: String) -> BuildModeEntry {
  BuildModeEntry { id: id.into(), label: label.into(), cmd }
}

#[tauri::command]
fn resolve_bp_class(path: String) -> Result<String, String> {
    use std::fs;
    let content = fs::read_to_string(&path).map_err(|e| format!("Cannot read {}: {}", path, e))?;
    let stem = std::path::Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown");

    // Handle module-info.java / package-info.java
    if stem.eq_ignore_ascii_case("module-info") {
        let module_name = content.lines()
            .find_map(|l| {
                let t = l.trim();
                if !t.starts_with("module ") { return None; }
                t.strip_prefix("module ")?.trim_end_matches('{').trim().split_whitespace().next()
            })
            .unwrap_or("module");
        return Ok(module_name.to_string());
    }
    if stem.eq_ignore_ascii_case("package-info") {
        let pkg = content.lines()
            .find_map(|l| {
                let t = l.trim();
                if !t.starts_with("package ") { return None; }
                Some(t.strip_prefix("package ")?.trim_end_matches(';').trim())
            })
            .unwrap_or("package-info");
        return Ok(pkg.to_string());
    }

    // Extract package from source (Java/Kotlin/Scala/Groovy)
    let pkg = content.lines()
        .find_map(|l| {
            let t = l.trim();
            if !t.starts_with("package ") { return None; }
            Some(t.strip_prefix("package ")?.trim_end_matches(';').trim())
        })
        .filter(|s| s.len() < 300 && s.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '_'));

    if let Some(p) = pkg {
        return Ok(if p.is_empty() { stem.to_string() } else { format!("{}.{}", p, stem) });
    }

    // Fallback: derive package from directory structure
    let p = std::path::Path::new(&path);
    let parent = p.parent().unwrap_or(std::path::Path::new(""));
    let parent_str = parent.to_string_lossy().replace('\\', "/");

    // Known source-root markers (in order of specificity)
    let markers = [
        "/src/main/java/", "/src/main/kotlin/", "/src/main/scala/",
        "/src/main/groovy/", "/src/main/java", "/src/main/kotlin",
        "/src/main/scala", "/src/main/groovy",
        "/src/", "/java/", "/kotlin/", "/scala/", "/groovy/",
    ];
    let after = markers.iter().find_map(|m| {
        let i = parent_str.find(m)?;
        let rest = &parent_str[i + m.len()..];
        if rest.is_empty() { None } else { Some(rest.trim_end_matches('/')) }
    });

    match after {
        Some(dir) => {
            let derived = dir.replace('/', ".");
            Ok(format!("{}.{}", derived, stem))
        }
        None => Ok(stem.to_string()),
    }
}

fn emitl(app: &AppHandle, text: String, kind: &str) {
  let _ = app.emit("log", LogLine { text, kind: kind.into() });
}
fn drain<R: std::io::Read + Send + 'static>(r: R, app: &AppHandle, kind: &'static str) {
  let a = app.clone();
  for line in std::io::BufReader::new(r).lines() {
    if let Ok(mut text) = line {
      // Strip trailing \r from Windows \r\n line endings so the frontend
      // doesn't insert spurious line breaks via CSS white-space:pre-wrap.
      if text.ends_with('\r') { text.pop(); }
      if text.is_empty() { text.push(' '); }
      let _ = a.emit("log", LogLine { text, kind: kind.into() });
    }
  }
}

// ── git add all ──
#[tauri::command]
fn git_add_all(path: String) -> Result<String, String> {
  eprintln!("[DEBUG] git_add_all: path={:?}", &path);
  let out = hid_cmd("git").args(["-C", &path, "add", "-A"])
    .output().map_err(|e| format!("git add -A: {}", e))?;
  let stderr = String::from_utf8(out.stderr).map_err(|_| "git: utf8 error".to_string())?;
  if !out.status.success() { return Err(stderr.trim().to_string()); }
  Ok("Staged all changes".to_string())
}

// ── git unstage ──
#[tauri::command]
fn git_unstage(path: String, file: String) -> Result<String, String> {
  eprintln!("[DEBUG] git_unstage: path={:?} file={:?}", &path, &file);
  let out = hid_cmd("git").args(["-C", &path, "restore", "--staged", "--", &file])
    .output().map_err(|e| format!("git unstage: {}", e))?;
  let stdout = String::from_utf8(out.stdout).map_err(|_| "git: utf8 error".to_string())?;
  let stderr = String::from_utf8(out.stderr).map_err(|_| "git: utf8 error".to_string())?;
  if !out.status.success() { return Err(stderr.trim().to_string()); }
  Ok(stdout.trim().to_string())
}

// ══════════════════════════════════════════════════
//  FILE READER / SAVER — for code editor
// ══════════════════════════════════════════════════

#[derive(Serialize)]
struct TerminalStartResult {
    id: String,
    has_tty: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileInfo {
    pub content: String,
    pub lines: Vec<String>,
    pub outline: Vec<OutlineItem>,
    pub class_view: Option<ClassView>,
    pub language: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OutlineItem {
    pub kind: String,
    pub name: String,
    pub line: usize,
    pub children: Vec<OutlineItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ClassView {
    pub name: String,
    pub methods: Vec<MethodInfo>,
    pub fields: Vec<FieldInfo>,
    pub extends: Option<String>,
    pub implements: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MethodInfo {
    pub name: String,
    pub signature: String,
    pub line: usize,
    pub visibility: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FieldInfo {
    pub name: String,
    pub type_name: String,
    pub line: usize,
    pub visibility: String,
}

// ══════════════════════════════════════════════════
//  FILE EXPLORER
// ══════════════════════════════════════════════════

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileEntry {
  pub name: String,
  pub path: String,
  pub is_dir: bool,
  pub is_symlink: bool,
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
  eprintln!("[DEBUG] list_dir called with path: {:?}", &path);
  let p = PathBuf::from(&path);
  if !p.exists() {
    eprintln!("[DEBUG] list_dir: path does not exist: {:?}", &p);
    return Err("Path does not exist".into());
  }
  if !p.is_dir() {
    eprintln!("[DEBUG] list_dir: path is not a directory: {:?}", &p);
    return Err("Path is not a directory".into());
  }

  let mut entries = Vec::new();
  let rd = std::fs::read_dir(&p).map_err(|e| {
    eprintln!("[DEBUG] list_dir: read_dir error: {}", &e);
    format!("Cannot read directory: {}", e)
  })?;

  for entry in rd.flatten() {
    let name = entry.file_name().to_string_lossy().to_string();
    if name.starts_with('.') { continue; }
    let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
    entries.push(FileEntry {
      is_symlink: entry.file_type().map(|t| t.is_symlink()).unwrap_or(false),
      path: entry.path().to_string_lossy().to_string(),
      is_dir,
      name,
    });
  }

  // sort: directories first, then files, alphabetical
  entries.sort_by(|a, b| {
    if a.is_dir != b.is_dir { return b.is_dir.cmp(&a.is_dir); }
    a.name.to_lowercase().cmp(&b.name.to_lowercase())
  });
  eprintln!("[DEBUG] list_dir: returning {} entries", entries.len());
  Ok(entries)
}

#[tauri::command]
fn read_file(path: String) -> Result<FileInfo, String> {
    eprintln!("[DEBUG] read_file called with path: {:?}", &path);
    let p = PathBuf::from(&path);
    if !p.exists() {
        eprintln!("[DEBUG] read_file: file not found: {:?}", &p);
        return Err(format!("File not found: {}", path));
    }
    eprintln!("[DEBUG] read_file: reading file...");
    let content = std::fs::read_to_string(&p).map_err(|e| {
        eprintln!("[DEBUG] read_file: read error: {}", &e);
        format!("Cannot read file: {}", e)
    })?;
    let lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let language = lang_from_ext(&ext);
    let outline = parse_outline(&content, &ext);
    let class_view = parse_class_view(&content, &ext);
    eprintln!("[DEBUG] read_file: returning {} lines, language={}", lines.len(), &language);
    Ok(FileInfo { content, lines, outline, class_view, language })
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    eprintln!("[DEBUG] save_file called with path: {:?}", &path);
    std::fs::write(&path, &content).map_err(|e| {
        eprintln!("[DEBUG] save_file error: {}", &e);
        format!("Cannot save file: {}", e)
    })
}

fn lang_from_ext(ext: &str) -> String {
    match ext {
        "rs" => "rust", "java" => "java", "kt" | "kts" => "kotlin",
        "scala" | "sc" => "scala", "py" => "python", "rb" => "ruby",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "ts" | "tsx" | "mts" | "cts" => "typescript",
        "go" => "go", "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" => "cpp",
        "cs" => "csharp", "swift" => "swift",
        "php" | "phtml" | "php3" | "php4" | "php5" | "php7" | "phps" => "php",
        "vue" => "vue", "svelte" => "svelte", "astro" => "astro",
        "json" => "json", "jsonc" => "jsonc", "xml" => "xml",
        "yaml" | "yml" => "yaml", "toml" => "toml",
        "md" | "mdx" => "markdown",
        "html" | "htm" | "xhtml" => "html",
        "css" | "scss" | "sass" | "less" => "css",
        "sh" | "bash" | "zsh" | "fish" => "shell",
        "ps1" | "psm1" => "powershell",
        "gradle" | "groovy" | "gvy" | "gsh" => "groovy",
        "sql" => "sql", "r" | "R" => "r",
        "erl" => "erlang", "hrl" => "erlang",
        "ex" | "exs" => "elixir", "cr" => "crystal",
        "jl" => "julia", "pl" | "pm" | "t" => "perl",
        "lua" => "lua", "nim" => "nim", "zig" => "zig",
        "v" => "v", "dart" => "dart",
        "dockerfile" | "Dockerfile" => "dockerfile",
        "makefile" | "Makefile" | "mk" => "makefile",
        "cmake" | "cmake.in" => "cmake",
        "proto" => "protobuf", "graphql" | "gql" => "graphql",
        "tex" | "sty" | "cls" | "ltx" => "latex",
        "hs" | "lhs" => "haskell", "sbt" => "scala",
        "clj" | "cljs" | "cljc" | "edn" => "clojure",
        "fs" | "fsx" => "fsharp",
        "tf" | "tfvars" => "terraform",
        _ => "plaintext",
    }.into()
}

fn parse_outline(content: &str, ext: &str) -> Vec<OutlineItem> {
    match ext {
        "java" => parse_java_outline(content),
        "rs" => parse_rust_outline(content),
        "py" => parse_python_outline(content),
        "go" => parse_go_outline(content),
        "ts" | "tsx" | "js" | "jsx" => parse_ts_outline(content),
        "kt" | "kts" => parse_kotlin_outline(content),
        "rb" => parse_ruby_outline(content),
        "php" => parse_php_outline(content),
        "erl" | "hrl" => parse_erlang_outline(content),
        "pl" | "pm" => parse_perl_outline(content),
        "jl" => parse_julia_outline(content),
        "cr" => parse_crystal_outline(content),
        "ex" | "exs" => parse_elixir_outline(content),
        _ => vec![],
    }
}

fn parse_class_view(content: &str, ext: &str) -> Option<ClassView> {
    match ext {
        "java" => parse_java_class(content),
        "rs" => parse_rust_class(content),
        "py" => parse_python_class(content),
        "go" => parse_go_class(content),
        "kt" | "kts" => parse_kotlin_class(content),
        "rb" => parse_ruby_class(content),
        "php" => parse_php_class(content),
        "cr" => parse_crystal_class(content),
        "ex" | "exs" => parse_elixir_class(content),
        _ => None,
    }
}

fn parse_java_outline(content: &str) -> Vec<OutlineItem> {
    let mut items: Vec<OutlineItem> = Vec::new();
    let mut depth: usize = 0;
    // Stack: (depth, parent_index_in_items)
    let mut stack: Vec<(usize, usize)> = Vec::new();

    for (i, line) in content.lines().enumerate() {
        let t = line.trim();

        // Track brace depth
        for ch in t.chars() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    if depth > 0 { depth -= 1; }
                    // Pop stack when exiting a scope
                    while let Some(&(d, _)) = stack.last() {
                        if d >= depth + 1 { stack.pop(); } else { break; }
                    }
                }
                _ => {}
            }
        }

        // Skip comments
        if t.starts_with("//") || t.starts_with("/*") || t.starts_with("*") || t.starts_with("/**") {
            continue;
        }

        let parent_idx = stack.last().map(|&(_, idx)| idx);

        // Class / Interface / Enum / Record / Annotation
        if t.starts_with("public class ") || t.starts_with("class ") {
            let name = t.split(|c| c == '{' || c == ' ' || c == '<').filter(|s| !s.is_empty()).nth(if t.starts_with("public ") { 2 } else { 1 }).unwrap_or("?").to_string();
            if let Some(pi) = parent_idx { if pi < items.len() {
                let idx = items[pi].children.len();
                items[pi].children.push(OutlineItem { kind: "class".into(), name: name.clone(), line: i + 1, children: vec![] });
                stack.push((depth, idx));
            }} else {
                let idx = items.len();
                items.push(OutlineItem { kind: "class".into(), name, line: i + 1, children: vec![] });
                stack.push((depth, idx));
            }
        } else if t.starts_with("public interface ") || t.starts_with("interface ") {
            let name = t.split(|c| c == '{' || c == ' ' || c == '<').filter(|s| !s.is_empty()).nth(if t.starts_with("public ") { 2 } else { 1 }).unwrap_or("?").to_string();
            if let Some(pi) = parent_idx { if pi < items.len() {
                let idx = items[pi].children.len();
                items[pi].children.push(OutlineItem { kind: "interface".into(), name: name.clone(), line: i + 1, children: vec![] });
                stack.push((depth, idx));
            }} else {
                let idx = items.len();
                items.push(OutlineItem { kind: "interface".into(), name, line: i + 1, children: vec![] });
                stack.push((depth, idx));
            }
        } else if t.starts_with("public enum ") || t.starts_with("enum ") {
            let name = t.split(|c| c == '{' || c == ' ').filter(|s| !s.is_empty()).nth(if t.starts_with("public ") { 2 } else { 1 }).unwrap_or("?").to_string();
            if let Some(pi) = parent_idx { if pi < items.len() {
                let idx = items[pi].children.len();
                items[pi].children.push(OutlineItem { kind: "enum".into(), name: name.clone(), line: i + 1, children: vec![] });
                stack.push((depth, idx));
            }} else {
                let idx = items.len();
                items.push(OutlineItem { kind: "enum".into(), name, line: i + 1, children: vec![] });
                stack.push((depth, idx));
            }
        } else if t.starts_with("@interface ") || t.starts_with("public @interface ") {
            let name = t.split(|c| c == '{' || c == ' ').filter(|s| !s.is_empty() && !s.starts_with('@')).last().unwrap_or("?").to_string();
            if let Some(pi) = parent_idx { if pi < items.len() {
                let idx = items[pi].children.len();
                items[pi].children.push(OutlineItem { kind: "annotation".into(), name: name.clone(), line: i + 1, children: vec![] });
                stack.push((depth, idx));
            }} else {
                let idx = items.len();
                items.push(OutlineItem { kind: "annotation".into(), name, line: i + 1, children: vec![] });
                stack.push((depth, idx));
            }
        } else if t.starts_with("record ") || t.starts_with("public record ") {
            let name = t.split(|c| c == '{' || c == ' ' || c == '(' || c == '<').filter(|s| !s.is_empty()).nth(if t.starts_with("public ") { 2 } else { 1 }).unwrap_or("?").to_string();
            if let Some(pi) = parent_idx { if pi < items.len() {
                let idx = items[pi].children.len();
                items[pi].children.push(OutlineItem { kind: "record".into(), name: name.clone(), line: i + 1, children: vec![] });
                stack.push((depth, idx));
            }} else {
                let idx = items.len();
                items.push(OutlineItem { kind: "record".into(), name, line: i + 1, children: vec![] });
                stack.push((depth, idx));
            }
        // Method: line containing '(' and ')' followed by '{', not a control flow keyword
        } else if depth > 0 && !t.starts_with("if ") && !t.starts_with("for ") && !t.starts_with("while ")
            && !t.starts_with("switch ") && !t.starts_with("catch ") && !t.starts_with("try ")
            && !t.starts_with("else ") && !t.starts_with("do ") && !t.starts_with("case ")
            && !t.starts_with("//") && !t.starts_with("/*") && !t.starts_with("*")
        {
            let has_paren = t.contains('(') && t.contains(')');
            let has_brace = line.trim_end().ends_with('{') || t.ends_with('{');
            if has_paren && has_brace {
                let name = t.split('(').next().unwrap_or("?").split_whitespace()
                    .filter(|s| *s != "{" && !s.is_empty())
                    .last().unwrap_or("?").to_string();
                let child = OutlineItem { kind: "method".into(), name, line: i + 1, children: vec![] };
                if let Some(pi) = parent_idx { if pi < items.len() { items[pi].children.push(child); } }
            }
        }
    }
    items
}

fn parse_rust_outline(content: &str) -> Vec<OutlineItem> {
    let mut items = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let t = line.trim();
        if t.starts_with("pub struct ") || t.starts_with("struct ") {
            let name = t.split(|c| c == '{' || c == ' ' || c == '<').nth(if t.starts_with("pub ") { 2 } else { 1 }).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "struct".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("pub enum ") || t.starts_with("enum ") {
            let name = t.split(|c| c == '{' || c == ' ').nth(if t.starts_with("pub ") { 2 } else { 1 }).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "enum".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("pub fn ") || t.starts_with("fn ") {
            let name = t.split(|c| c == '(' || c == ' ' || c == '<').nth(if t.starts_with("pub ") { 2 } else { 1 }).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "function".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("pub trait ") || t.starts_with("trait ") {
            let name = t.split(|c| c == '{' || c == ' ' || c == '<').nth(if t.starts_with("pub ") { 2 } else { 1 }).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "trait".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("pub impl") || t.starts_with("impl ") {
            let name = t.split_whitespace().nth(if t.starts_with("pub ") { 2 } else { 1 }).map(|s| s.trim_end_matches('{')).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "impl".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("pub mod ") || t.starts_with("mod ") {
            let name = t.split_whitespace().nth(if t.starts_with("pub ") { 2 } else { 1 }).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "module".into(), name, line: i + 1, children: vec![] });
        }
    }
    items
}

fn parse_python_outline(content: &str) -> Vec<OutlineItem> {
    let mut items = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let t = line.trim();
        if t.starts_with("class ") {
            let name = t.split(|c| c == '(' || c == ':' || c == ' ').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "class".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("def ") {
            let name = t.split(|c| c == '(' || c == ' ').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "function".into(), name, line: i + 1, children: vec![] });
        }
    }
    items
}

fn parse_go_outline(content: &str) -> Vec<OutlineItem> {
    let mut items = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let t = line.trim();
        if t.starts_with("type ") && (t.contains(" struct") || t.contains(" interface")) {
            let name = t.split_whitespace().nth(1).unwrap_or("?").to_string();
            let kind = if t.contains(" struct") { "struct" } else { "interface" };
            items.push(OutlineItem { kind: kind.into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("func ") {
            let name = t.split(|c| c == '(' || c == ' ').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "function".into(), name, line: i + 1, children: vec![] });
        }
    }
    items
}

fn parse_ts_outline(content: &str) -> Vec<OutlineItem> {
    let mut items = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let t = line.trim();
        if t.starts_with("export ") {
            let rest = t.trim_start_matches("export ");
            if rest.starts_with("class ") || rest.starts_with("interface ") || rest.starts_with("type ") || rest.starts_with("enum ") || rest.starts_with("function ") || rest.starts_with("const ") || rest.starts_with("let ") || rest.starts_with("var ") {
                let kind = rest.split_whitespace().next().unwrap_or("?").to_string();
                let name = rest.split_whitespace().nth(1).unwrap_or("?").to_string();
                items.push(OutlineItem { kind, name, line: i + 1, children: vec![] });
            }
        } else if t.starts_with("class ") || t.starts_with("interface ") || t.starts_with("type ") || t.starts_with("enum ") || t.starts_with("function ") {
            let kind = t.split_whitespace().next().unwrap_or("?").to_string();
            let name = t.split_whitespace().nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind, name, line: i + 1, children: vec![] });
        }
    }
    items
}

fn parse_kotlin_outline(content: &str) -> Vec<OutlineItem> {
    let mut items = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let t = line.trim();
        if t.starts_with("class ") || t.starts_with("data class ") || t.starts_with("sealed class ") {
            let name = t.split(|c| c == '{' || c == ' ' || c == '(' || c == '<').nth(if t.starts_with("data") || t.starts_with("sealed") { 2 } else { 1 }).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "class".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("fun ") {
            let name = t.split(|c| c == '(' || c == ' ').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "function".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("object ") {
            let name = t.split(|c| c == '{' || c == ' ').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "object".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("interface ") {
            let name = t.split(|c| c == '{' || c == ' ').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "interface".into(), name, line: i + 1, children: vec![] });
        }
    }
    items
}

fn parse_ruby_outline(content: &str) -> Vec<OutlineItem> {
    let mut items = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let t = line.trim();
        if t.starts_with("class ") || t.starts_with("module ") {
            let kind = if t.starts_with("class ") { "class" } else { "module" };
            let name = t.split(|c| c == ' ' || c == '<' || c == ';').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: kind.into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("def ") {
            let name = t.split(|c| c == '(' || c == ' ' || c == ';').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "method".into(), name, line: i + 1, children: vec![] });
        }
    }
    items
}

fn parse_php_outline(content: &str) -> Vec<OutlineItem> {
    let mut items = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let t = line.trim();
        if t.starts_with("class ") || t.starts_with("abstract class ") || t.starts_with("final class ") {
            let name = t.split(|c| c == ' ' || c == '{' || c == ':' || c == ';').nth(if t.starts_with("abstract") || t.starts_with("final") { 2 } else { 1 }).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "class".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("interface ") {
            let name = t.split(|c| c == ' ' || c == '{' || c == ';').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "interface".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("trait ") {
            let name = t.split(|c| c == ' ' || c == '{' || c == ';').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "trait".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("function ") || t.starts_with("public function ") || t.starts_with("private function ") || t.starts_with("protected function ") {
            let name = t.split(|c| c == '(' || c == ' ').last().unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "function".into(), name, line: i + 1, children: vec![] });
        }
    }
    items
}

fn parse_erlang_outline(content: &str) -> Vec<OutlineItem> {
    let mut items = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let t = line.trim();
        if t.starts_with("-module(") {
            let name = t.split(|c| c == '(' || c == ')' || c == '.').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "module".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("-export(") || t.starts_with("-export_type(") {
            // skip export lines
        } else if t.starts_with("-record(") {
            let name = t.split(|c| c == '(' || c == ',' || c == '{').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "record".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("-type(") || t.starts_with("-opaque(") {
            let kind = if t.starts_with("-opaque") { "opaque" } else { "type" };
            let name = t.split(|c| c == '(' || c == ',' || c == ' ').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: kind.into(), name, line: i + 1, children: vec![] });
        } else if t.ends_with(") ->") || t.contains(") -> ") {
            let name = t.split('(').next().unwrap_or("?").trim().to_string();
            if !name.is_empty() && !name.starts_with('%') && !name.starts_with('-') {
                items.push(OutlineItem { kind: "function".into(), name, line: i + 1, children: vec![] });
            }
        }
    }
    items
}

fn parse_perl_outline(content: &str) -> Vec<OutlineItem> {
    let mut items = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let t = line.trim();
        if t.starts_with("package ") {
            let name = t.split(|c| c == ' ' || c == ';').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "package".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("sub ") {
            let name = t.split(|c| c == ' ' || c == '{' || c == ';').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "function".into(), name, line: i + 1, children: vec![] });
        }
    }
    items
}

fn parse_julia_outline(content: &str) -> Vec<OutlineItem> {
    let mut items = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let t = line.trim();
        if t.starts_with("module ") {
            let name = t.split(|c| c == ' ' || c == '{' || c == ';').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "module".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("struct ") || t.starts_with("mutable struct ") {
            let name = t.split(|c| c == ' ' || c == '{' || c == ';').nth(if t.starts_with("mutable") { 2 } else { 1 }).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "struct".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("function ") || t.starts_with("function ") {
            let name = t.split(|c| c == '(' || c == ' ' || c == '{').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "function".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("abstract type ") || t.starts_with("primitive type ") {
            let name = t.split(|c| c == ' ' || c == '{' || c == ';').nth(2).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "type".into(), name, line: i + 1, children: vec![] });
        }
    }
    items
}

fn parse_crystal_outline(content: &str) -> Vec<OutlineItem> {
    let mut items = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let t = line.trim();
        if t.starts_with("class ") || t.starts_with("abstract class ") || t.starts_with("struct ") {
            let kind = if t.starts_with("struct") { "struct" } else { "class" };
            let name = t.split(|c| c == ' ' || c == '{' || c == ';').nth(if t.starts_with("abstract") { 2 } else { 1 }).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: kind.into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("def ") {
            let name = t.split(|c| c == '(' || c == ' ' || c == ';').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "method".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("module ") {
            let name = t.split(|c| c == ' ' || c == '{' || c == ';').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "module".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("enum ") {
            let name = t.split(|c| c == ' ' || c == '{' || c == ';').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "enum".into(), name, line: i + 1, children: vec![] });
        }
    }
    items
}

fn parse_elixir_outline(content: &str) -> Vec<OutlineItem> {
    let mut items = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let t = line.trim();
        if t.starts_with("defmodule ") {
            let name = t.split(|c| c == ' ' || c == '{' || c == ';').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "module".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("def ") || t.starts_with("defp ") {
            let kind = if t.starts_with("defp") { "private" } else { "function" };
            let name = t.split(|c| c == '(' || c == ' ' || c == '/' || c == ';').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: kind.into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("defstruct ") {
            let name = t.split(|c| c == ' ' || c == '[' || c == ';').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "struct".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("defimpl ") {
            let name = t.split(|c| c == ' ' || c == ',' || c == ';').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "impl".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("defprotocol ") {
            let name = t.split(|c| c == ' ' || c == '{' || c == ';').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "protocol".into(), name, line: i + 1, children: vec![] });
        } else if t.starts_with("defmacro ") || t.starts_with("defmacrop ") {
            let name = t.split(|c| c == '(' || c == ' ' || c == ';').nth(1).unwrap_or("?").to_string();
            items.push(OutlineItem { kind: "macro".into(), name, line: i + 1, children: vec![] });
        }
    }
    items
}

fn parse_java_class(content: &str) -> Option<ClassView> {
    let lines: Vec<&str> = content.lines().collect();
    let class_line = lines.iter().position(|l| l.trim().starts_with("class ") || l.trim().starts_with("public class ") || l.trim().starts_with("public final class ") || l.trim().starts_with("public abstract class "))?;
    let line = lines[class_line].trim();
    let name = line.split(|c| c == '{' || c == ' ' || c == '<' || c == '(').nth(if line.starts_with("public") { if line.contains("final") || line.contains("abstract") { 3 } else { 2 } } else { 1 }).unwrap_or("?").to_string();
    let extends = if line.contains("extends") {
        line.split("extends").nth(1).and_then(|s| s.split_whitespace().next()).map(|s| s.trim().to_string())
    } else { None };
    let implements: Vec<String> = if line.contains("implements") {
        line.split("implements").nth(1).map(|s| s.split(|c| c == '{' || c == ',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()).unwrap_or_default()
    } else { vec![] };
    let mut methods = Vec::new();
    let mut fields = Vec::new();
    let mut in_class = false;
    let mut brace_depth = 0i32;
    for (i, &l) in lines.iter().enumerate() {
        let t = l.trim();
        if t.contains('{') && (t.starts_with("class ") || t.starts_with("public class ") || t.starts_with("public final class ") || t.starts_with("public abstract class ") || t.starts_with("interface ") || t.starts_with("enum ")) {
            in_class = true;
            brace_depth += t.matches('{').count() as i32 - t.matches('}').count() as i32;
            continue;
        }
        if !in_class { continue; }
        brace_depth += t.matches('{').count() as i32 - t.matches('}').count() as i32;
        if brace_depth <= 0 { break; }
        let vis = if t.starts_with("public ") { "public" } else if t.starts_with("private ") { "private" } else if t.starts_with("protected ") { "protected" } else { "package" };
        let after_vis = if vis != "package" { t.splitn(2, ' ').nth(1).unwrap_or("") } else { t };
        if t.contains('(') && t.contains(')') && !t.starts_with("//") && !t.starts_with("/*") && !t.starts_with('*') {
            let name = after_vis.split('(').next().and_then(|s| s.split_whitespace().last()).unwrap_or("?").to_string();
            let sig = t.trim_end_matches('{').trim().to_string();
            if !name.is_empty() && !name.starts_with(')') {
                methods.push(MethodInfo { name, signature: sig, line: i + 1, visibility: vis.into() });
            }
        } else if t.contains(';') && !t.starts_with("//") && !t.starts_with("/*") && !t.starts_with('*') {
            let parts: Vec<&str> = after_vis.split_whitespace().collect();
            if parts.len() >= 2 {
                let last = parts.last().unwrap_or(&"").trim_end_matches(';');
                let type_name = parts[0..parts.len()-1].join(" ");
                if !type_name.is_empty() && !last.is_empty() && !type_name.contains('(') {
                    fields.push(FieldInfo { name: last.to_string(), type_name, line: i + 1, visibility: vis.into() });
                }
            }
        }
    }
    Some(ClassView { name, methods, fields, extends, implements })
}

fn parse_rust_class(content: &str) -> Option<ClassView> {
    let lines: Vec<&str> = content.lines().collect();
    let struct_idx = lines.iter().position(|l| l.trim().starts_with("struct ") || l.trim().starts_with("pub struct "))?;
    let line = lines[struct_idx].trim();
    let name = line.split(|c| c == '{' || c == ' ' || c == '<').nth(if line.starts_with("pub ") { 2 } else { 1 }).unwrap_or("?").to_string();
    let mut fields = Vec::new();
    let mut in_struct = false;
    for (i, &l) in lines.iter().enumerate().skip(struct_idx + 1) {
        let t = l.trim();
        if t.starts_with('}') { break; }
        if t.contains('{') { in_struct = true; continue; }
        if in_struct && t.contains(':') {
            let parts: Vec<&str> = t.splitn(2, ':').collect();
            let fname = parts[0].trim().trim_start_matches("pub ").trim().to_string();
            let ftype = parts[1].trim().trim_end_matches(',').trim().to_string();
            if !fname.is_empty() && !ftype.is_empty() {
                let vis = if l.contains("pub ") { "public" } else { "private" };
                fields.push(FieldInfo { name: fname, type_name: ftype, line: i + 1, visibility: vis.into() });
            }
        }
    }
    let mut methods = Vec::new();
    if let Some(idx) = lines.iter().position(|l| l.trim().starts_with("impl ") || l.trim().starts_with("pub impl ")) {
        for (i, &l) in lines.iter().enumerate().skip(idx + 1) {
            let t = l.trim();
            if t.starts_with('}') { break; }
            if t.starts_with("fn ") || t.starts_with("pub fn ") {
                let wc = if t.starts_with("pub ") { 2 } else { 1 };
                let name = t.split(|c| c == '(' || c == ' ').nth(wc).unwrap_or("?").to_string();
                let sig = t.trim_end_matches('{').trim().to_string();
                let vis = if t.contains("pub") { "public" } else { "private" };
                methods.push(MethodInfo { name, signature: sig, line: i + 1, visibility: vis.into() });
            }
        }
    }
    Some(ClassView { name, methods, fields, extends: None, implements: vec![] })
}

fn parse_python_class(content: &str) -> Option<ClassView> {
    let lines: Vec<&str> = content.lines().collect();
    let cls_idx = lines.iter().position(|l| l.trim().starts_with("class "))?;
    let line = lines[cls_idx].trim();
    let name = line.split(|c| c == '(' || c == ':' || c == ' ').nth(1).unwrap_or("?").to_string();
    let extends = if line.contains('(') {
        line.split('(').nth(1).and_then(|s| s.split(')').next()).map(|s| s.trim().to_string())
    } else { None };
    let mut methods = Vec::new();
    let mut fields = Vec::new();
    for (i, &l) in lines.iter().enumerate().skip(cls_idx + 1) {
        let t = l.trim();
        if t.starts_with("def ") {
            let name = t.split(|c| c == '(' || c == ' ').nth(1).unwrap_or("?").to_string();
            let sig = format!("def {}", name);
            let vis = if name.starts_with("__") { "private" } else { "public" };
            methods.push(MethodInfo { name, signature: sig, line: i + 1, visibility: vis.into() });
        } else if t.contains('=') && !t.starts_with("def ") && !t.starts_with("class ") && !t.starts_with("import ") {
            let parts: Vec<&str> = t.splitn(2, '=').collect();
            let fname = parts[0].trim().to_string();
            if !fname.starts_with('_') && !fname.is_empty() {
                fields.push(FieldInfo { name: fname, type_name: "Any".into(), line: i + 1, visibility: "public".into() });
            }
        }
    }
    Some(ClassView { name, methods, fields, extends, implements: vec![] })
}

fn parse_go_class(content: &str) -> Option<ClassView> {
    let lines: Vec<&str> = content.lines().collect();
    let struct_idx = lines.iter().position(|l| l.trim().starts_with("type ") && l.contains("struct"))?;
    let line = lines[struct_idx].trim();
    let name = line.split_whitespace().nth(1).unwrap_or("?").to_string();
    let mut fields = Vec::new();
    let mut in_struct = false;
    for (i, &l) in lines.iter().enumerate().skip(struct_idx + 1) {
        let t = l.trim();
        if t.starts_with('}') { break; }
        if t.contains('{') { in_struct = true; continue; }
        if in_struct && !t.is_empty() {
            let parts: Vec<&str> = t.split_whitespace().collect();
            if parts.len() >= 2 {
                let fname = parts[0].to_string();
                let ftype = parts[1..].join(" ").trim_end_matches(',').to_string();
                fields.push(FieldInfo { name: fname, type_name: ftype, line: i + 1, visibility: "public".into() });
            }
        }
    }
    let mut methods = Vec::new();
    for (i, &l) in lines.iter().enumerate() {
        let t = l.trim();
        if t.starts_with("func ") && t.contains(&name) {
            let sig = t.trim_end_matches('{').trim().to_string();
            let n = t.split_whitespace().nth(2).and_then(|s| s.split('(').next()).unwrap_or("?").to_string();
            methods.push(MethodInfo { name: n, signature: sig, line: i + 1, visibility: "public".into() });
        }
    }
    Some(ClassView { name, methods, fields, extends: None, implements: vec![] })
}

fn parse_kotlin_class(content: &str) -> Option<ClassView> {
    let lines: Vec<&str> = content.lines().collect();
    let cls_idx = lines.iter().position(|l| {
        let t = l.trim();
        t.starts_with("class ") || t.starts_with("data class ") || t.starts_with("sealed class ")
    })?;
    let line = lines[cls_idx].trim();
    let name = line.split(|c| c == '{' || c == ' ' || c == '(' || c == '<').nth(if line.starts_with("data") || line.starts_with("sealed") { 2 } else { 1 }).unwrap_or("?").to_string();
    let extends = if line.contains(':') {
        line.split(':').nth(1).and_then(|s| s.split_whitespace().next()).map(|s| s.trim().to_string())
    } else { None };
    let mut methods = Vec::new();
    let mut fields = Vec::new();
    let mut in_class = false;
    let mut brace_depth = 0i32;
    for (i, &l) in lines.iter().enumerate().skip(cls_idx) {
        let t = l.trim();
        if i == cls_idx {
            brace_depth += t.matches('{').count() as i32 - t.matches('}').count() as i32;
            in_class = true;
            continue;
        }
        if !in_class { continue; }
        brace_depth += t.matches('{').count() as i32 - t.matches('}').count() as i32;
        if brace_depth <= 0 { break; }
        if t.starts_with("fun ") && !t.starts_with("//") {
            let name = t.split(|c| c == '(' || c == ' ').nth(1).unwrap_or("?").to_string();
            let sig = t.trim_end_matches('{').trim().to_string();
            methods.push(MethodInfo { name, signature: sig, line: i + 1, visibility: "public".into() });
        } else if t.contains("var ") || t.contains("val ") {
            let parts: Vec<&str> = t.split_whitespace().collect();
            if let Some(pos) = parts.iter().position(|&p| p == "var" || p == "val") {
                let name = parts.get(pos + 1).unwrap_or(&"?").trim_end_matches(':').to_string();
                let type_name = parts.get(pos + 2).map(|s| s.to_string()).unwrap_or_else(|| "Any".into());
                fields.push(FieldInfo { name, type_name, line: i + 1, visibility: "public".into() });
            }
        }
    }
    Some(ClassView { name, methods, fields, extends, implements: vec![] })
}

fn parse_ruby_class(content: &str) -> Option<ClassView> {
    let lines: Vec<&str> = content.lines().collect();
    let cls_idx = lines.iter().position(|l| l.trim().starts_with("class "))?;
    let line = lines[cls_idx].trim();
    let name = line.split(|c| c == ' ' || c == '<' || c == ';').nth(1).unwrap_or("?").to_string();
    let extends = if line.contains('<') {
        line.split('<').nth(1).map(|s| s.split_whitespace().next().unwrap_or("").trim().to_string())
    } else { None };
    let mut methods = Vec::new();
    let mut fields = Vec::new();
    for (i, &l) in lines.iter().enumerate().skip(cls_idx + 1) {
        let t = l.trim();
        if t.starts_with("end") { break; }
        if t.starts_with("def ") {
            let name = t.split(|c| c == '(' || c == ' ' || c == ';').nth(1).unwrap_or("?").to_string();
            let vis = if name.starts_with('_') { "private" } else { "public" };
            methods.push(MethodInfo { name: name.clone(), signature: format!("def {}", name), line: i + 1, visibility: vis.into() });
        } else if t.contains("attr_accessor") || t.contains("attr_reader") || t.contains("attr_writer") {
            let parts: Vec<&str> = t.split(':').collect();
            for p in parts {
                let fname = p.trim().trim_start_matches(' ').trim_start_matches(':');
                if !fname.is_empty() && !fname.starts_with("attr_") {
                    fields.push(FieldInfo { name: fname.to_string(), type_name: "Object".into(), line: i + 1, visibility: "public".into() });
                }
            }
        }
    }
    Some(ClassView { name, methods, fields, extends, implements: vec![] })
}

fn parse_php_class(content: &str) -> Option<ClassView> {
    let lines: Vec<&str> = content.lines().collect();
    let cls_idx = lines.iter().position(|l| {
        let t = l.trim(); t.starts_with("class ") || t.starts_with("abstract class ") || t.starts_with("final class ")
    })?;
    let line = lines[cls_idx].trim();
    let name = line.split(|c| c == ' ' || c == '{' || c == ':' || c == ';').nth(if line.starts_with("abstract") || line.starts_with("final") { 2 } else { 1 }).unwrap_or("?").to_string();
    let extends = if line.contains("extends") {
        line.split("extends").nth(1).and_then(|s| s.split_whitespace().next()).map(|s| s.trim().to_string())
    } else { None };
    let implements: Vec<String> = if line.contains("implements") {
        line.split("implements").nth(1).map(|s| s.split(|c| c == '{' || c == ',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()).unwrap_or_default()
    } else { vec![] };
    let mut methods = Vec::new();
    let mut fields = Vec::new();
    let mut in_class = false;
    let mut brace_depth = 0i32;
    for (i, &l) in lines.iter().enumerate().skip(cls_idx) {
        let t = l.trim();
        if i == cls_idx {
            brace_depth += t.matches('{').count() as i32 - t.matches('}').count() as i32;
            in_class = true; continue;
        }
        if !in_class { continue; }
        brace_depth += t.matches('{').count() as i32 - t.matches('}').count() as i32;
        if brace_depth <= 0 { break; }
        let vis = if t.starts_with("public ") { "public" } else if t.starts_with("private ") { "private" } else if t.starts_with("protected ") { "protected" } else { "public" };
        if (t.starts_with("function ") || t.starts_with("public function ") || t.starts_with("private function ") || t.starts_with("protected function ")) && t.contains('(') {
            let name = t.split(|c| c == '(' || c == ' ').last().unwrap_or("?").to_string();
            let sig = t.trim_end_matches('{').trim().to_string();
            methods.push(MethodInfo { name, signature: sig, line: i + 1, visibility: vis.into() });
        } else if t.contains("$") && t.contains(';') && (t.starts_with("public ") || t.starts_with("private ") || t.starts_with("protected ") || t.starts_with("var ") || t.starts_with("static ")) {
            let parts: Vec<&str> = t.split_whitespace().collect();
            if let Some(pos) = parts.iter().position(|&p| p.starts_with('$')) {
                let fname = parts[pos].trim_end_matches(';').trim_start_matches('$').to_string();
                let type_name = if pos > 0 && !parts[pos-1].starts_with('$') && !parts[pos-1].contains("function") { parts[pos-1].to_string() } else { "mixed".into() };
                fields.push(FieldInfo { name: fname, type_name, line: i + 1, visibility: vis.into() });
            }
        }
    }
    Some(ClassView { name, methods, fields, extends, implements })
}

fn parse_crystal_class(content: &str) -> Option<ClassView> {
    let lines: Vec<&str> = content.lines().collect();
    let cls_idx = lines.iter().position(|l| l.trim().starts_with("class ") || l.trim().starts_with("abstract class ") || l.trim().starts_with("struct "))?;
    let line = lines[cls_idx].trim();
    let name = line.split(|c| c == ' ' || c == '{' || c == ';').nth(if line.starts_with("abstract") { 2 } else { 1 }).unwrap_or("?").to_string();
    let extends = if line.contains('<') {
        line.split('<').nth(1).and_then(|s| s.split_whitespace().next()).map(|s| s.trim().to_string())
    } else { None };
    let mut methods = Vec::new();
    let mut fields = Vec::new();
    let mut in_class = false;
    let mut brace_depth = 0i32;
    for (i, &l) in lines.iter().enumerate().skip(cls_idx) {
        let t = l.trim();
        if i == cls_idx {
            brace_depth += t.matches('{').count() as i32 - t.matches('}').count() as i32;
            in_class = true; continue;
        }
        if !in_class { continue; }
        brace_depth += t.matches('{').count() as i32 - t.matches('}').count() as i32;
        if brace_depth <= 0 { break; }
        if t.starts_with("def ") {
            let name = t.split(|c| c == '(' || c == ' ' || c == ';').nth(1).unwrap_or("?").to_string();
            let sig = t.trim_end_matches('{').trim().to_string();
            methods.push(MethodInfo { name, signature: sig, line: i + 1, visibility: "public".into() });
        } else if t.starts_with("property ") || t.starts_with("getter ") || t.starts_with("setter ") {
            let name = t.split_whitespace().nth(1).unwrap_or("?").to_string();
            fields.push(FieldInfo { name, type_name: "auto".into(), line: i + 1, visibility: "public".into() });
        }
    }
    Some(ClassView { name, methods, fields, extends, implements: vec![] })
}

fn parse_elixir_class(content: &str) -> Option<ClassView> {
    let lines: Vec<&str> = content.lines().collect();
    let mod_idx = lines.iter().position(|l| l.trim().starts_with("defmodule "))?;
    let line = lines[mod_idx].trim();
    let name = line.split(|c| c == ' ' || c == '{' || c == ';').nth(1).unwrap_or("?").to_string();
    let mut methods = Vec::new();
    let mut fields = Vec::new();
    for (i, &l) in lines.iter().enumerate().skip(mod_idx + 1) {
        let t = l.trim();
        if t.starts_with("end") && lines.iter().skip(i+1).any(|l2| l2.trim().starts_with("defmodule")) { break; }
        if t.starts_with("def ") || t.starts_with("defp ") {
            let kind = if t.starts_with("defp") { "private" } else { "public" };
            let name = t.split(|c| c == '(' || c == ' ' || c == '/' || c == ';').nth(1).unwrap_or("?").to_string();
            let sig = t.split('(').next().unwrap_or("?").to_string();
            methods.push(MethodInfo { name, signature: sig, line: i + 1, visibility: kind.into() });
        } else if t.starts_with("defstruct ") {
            let rest = t.trim_start_matches("defstruct ");
            for item in rest.split(|c| c == '[' || c == ']' || c == ',' || c == ' ') {
                let parts: Vec<&str> = item.split(':').collect();
                if parts.len() >= 2 {
                    fields.push(FieldInfo { name: parts[0].trim().to_string(), type_name: "any".into(), line: i + 1, visibility: "public".into() });
                }
            }
        }
    }
    Some(ClassView { name, methods, fields, extends: None, implements: vec![] })
}

// ── Maven profiles ──

fn read_maven_profiles(p: &PathBuf) -> Vec<String> {
  let pom = match std::fs::read_to_string(p.join("pom.xml")) { Ok(s) => s, Err(_) => return vec![] };
  let mut seen = std::collections::BTreeSet::new();
  let mut profiles = vec![];
  let mut in_profile = false;
  for line in pom.lines() {
    let t = line.trim();
    if t.starts_with("<profile>")      { in_profile = true; continue; }
    if t.starts_with("</profile>")     { in_profile = false; continue; }
    if in_profile && (t.starts_with("<id>") || t.starts_with("<id ")) {
      let id = t.replace("<id>","").replace("</id>","").replace("<id ","").replace("/>","").replace(">","").split_whitespace().next().unwrap_or("").to_string();
      if !id.is_empty() && seen.insert(id.clone()) { profiles.push(id); }
    }
  }
  profiles
}

// ── npm/yarn/pnpm scripts ──

fn extract_npm_scripts(pkg_json: &str) -> std::collections::BTreeMap<String, String> {
  let mut scripts = std::collections::BTreeMap::new();
  if let Ok(v) = serde_json::from_str::<serde_json::Value>(pkg_json) {
    if let Some(obj) = v.get("scripts").and_then(|s| s.as_object()) {
      for (k, v) in obj {
        if let Some(cmd) = v.as_str() { scripts.insert(k.clone(), cmd.into()); }
      }
    }
  }
  scripts
}

// ── Project-type detection ──

fn has_dotnet(p: &PathBuf) -> bool {
  if let Ok(es) = std::fs::read_dir(p) {
    for entry in es.flatten() {
      if let Some(fname) = entry.file_name().to_str() {
        if fname.ends_with(".csproj") || fname.ends_with(".fsproj") || fname == "Directory.Packages.props" {
          return true;
        }
      }
    }
  }
  false
}

fn py_files_any(p: &PathBuf) -> bool {
  if p.join("requirements.txt").exists() || p.join("Pipfile").exists() { return true; }
  if let Ok(es) = std::fs::read_dir(p) {
    for e in es.flatten() {
      if e.path().extension().is_some_and(|x| x == "py") { return true; }
    }
  }
  false
}

fn java_count(p: &PathBuf) -> usize {
  let src = p.join("src");
  if !src.exists() { return 0; }
  walkdir::WalkDir::new(src).into_iter()
    .filter_map(|e| e.ok())
    .filter(|e| e.path().extension().is_some_and(|x| x == "java"))
    .count()
}

fn find_file(p: &PathBuf, pattern: &str) -> Option<String> {
  if pattern.contains('*') {
    let ext = pattern.trim_start_matches('*');
    if let Ok(es) = std::fs::read_dir(p) {
      for entry in es.flatten() {
        if let Some(name) = entry.file_name().to_str() {
          if name.ends_with(ext) { return Some(name.to_string()); }
        }
      }
    }
    None
  } else {
    let full = p.join(pattern);
    if full.exists() { Some(pattern.to_string()) } else { None }
  }
}

fn glob_has(p: &PathBuf, pattern: &str) -> bool {
  find_file(p, pattern).is_some()
}

fn guess_java_main(p: &PathBuf) -> Option<String> {
  let src = p.join("src");
  if !src.exists() { return None; }
  let mut main_class = None;
  for entry in walkdir::WalkDir::new(&src).into_iter().flatten() {
    let path = entry.path();
    if path.extension().is_some_and(|x| x == "java") {
      if let Ok(content) = std::fs::read_to_string(path) {
        if content.contains("public static void main") {
          if let Some(cname) = path.file_stem().and_then(|s| s.to_str()) {
            let rel = path.strip_prefix(&src).ok()?;
            let pkg = rel.parent()?;
            let pkg_name = pkg.to_str().filter(|s| !s.is_empty()).map(|s| s.replace(std::path::MAIN_SEPARATOR_STR, "."));
            main_class = Some(pkg_name.map(|p| format!("{}.{}", p, cname)).unwrap_or_else(|| cname.to_string()));
            break;
          }
        }
      }
    }
  }
  main_class
}

// ── Tool versions ──

fn run_ver(cmdline: &str) -> Option<std::process::Output> {
  let mut c = hid_cmd("cmd");
  c.args(["/C", cmdline]).stdout(Stdio::piped()).stderr(Stdio::piped());
  c.output().ok()
}
fn java_ver() -> Option<String> {
  run_ver("javac -version")
    .and_then(|o| String::from_utf8(o.stderr).ok())
    .and_then(|s| s.split_whitespace().find(|p| p.starts_with(char::is_numeric)).map(|s| s.into()))
}
fn py_ver() -> Option<String> {
  run_ver("python --version")
    .and_then(|o| String::from_utf8(o.stdout).ok())
    .or_else(|| run_ver("python3 --version").and_then(|o| String::from_utf8(o.stdout).ok()))
    .map(|s| s.trim().into())
}
fn dotnet_ver() -> Option<String> {
  run_ver("dotnet --version")
    .and_then(|o| String::from_utf8(o.stdout).ok())
    .map(|s| s.trim().into())
}
fn go_ver() -> Option<String> {
  run_ver("go version")
    .and_then(|o| String::from_utf8(o.stdout).ok())
    .and_then(|s| s.split_whitespace().nth(2).map(|s| s.into()))
}
fn cargo_ver() -> Option<String> {
  run_ver("cargo --version")
    .and_then(|o| String::from_utf8(o.stdout).ok())
    .map(|s| s.trim().into())
}
fn cmake_ver() -> Option<String> {
  run_ver("cmake --version")
    .and_then(|o| String::from_utf8(o.stdout).ok())
    .and_then(|s| s.lines().next().map(|s| s.trim().into()))
}

fn guess_py_entry(p: &PathBuf) -> Option<String> {
  if p.join("main.py").exists()  { return Some("python main.py".into()); }
  if p.join("app.py").exists()   { return Some("python app.py".into()); }
  if p.join("manage.py").exists() { return Some("python manage.py runserver".into()); }
  if let Ok(c) = std::fs::read_to_string(p.join("pyproject.toml")) {
    if let Some(l) = c.lines().find(|l| l.contains("= \"") && l.contains(".py:")) {
      let c = l.split('=').next_back()?.trim().replace('"', "");
      if !c.is_empty() { return Some(format!("python {}", c)); }
    }
  }
  None
}

#[tauri::command]
fn git_status(path: String) -> Result<Vec<Vec<String>>, String> {
  let out = hid_cmd("git").args(["-C", &path, "status", "--porcelain"])
    .output().map_err(|e| format!("git: {}", e))?;
  let s = String::from_utf8(out.stdout).map_err(|_| String::from("git: utf8 error"))?;
  Ok(s.lines().filter_map(|l| {
    if l.len() < 4 { return None; }
    let xy = &l[..2];
    let file = l[3..].trim().to_string();
    Some(vec![xy.to_string(), file])
  }).collect())
}

#[tauri::command]
fn git_checkout(path: String, branch: String) -> Result<String, String> {
  eprintln!("[DEBUG] git_checkout: branch={:?}", &branch);
  let args = if branch.starts_with("origin/") {
    vec!["-C", &path, "checkout", "--track", &branch]
  } else {
    vec!["-C", &path, "checkout", &branch]
  };
  let out = hid_cmd("git").args(&args).output().map_err(|e| format!("git: {}", e))?;
  let stdout = String::from_utf8(out.stdout).map_err(|_| "git: utf8 error".to_string())?;
  let stderr = String::from_utf8(out.stderr).map_err(|_| "git: utf8 error".to_string())?;
  eprintln!("[DEBUG] git_checkout: stdout={:?} stderr={:?}", stdout, stderr);
  if !out.status.success() {
    return Err(stderr.trim().to_string());
  }
  Ok(stdout.trim().to_string())
}

#[tauri::command]
fn git_remote_url(path: String) -> Result<String, String> {
  let out = hid_cmd("git").args(["-C", &path, "remote", "get-url", "origin"])
    .output().map_err(|e| format!("git: {}", e))?;
  let s = String::from_utf8(out.stdout).map_err(|_| String::from("git: utf8 error"))?;
  Ok(s.trim().to_string())
}

#[tauri::command]
fn git_branches(path: String) -> Result<Vec<Vec<String>>, String> {
  let branches = |args: &[&str]| -> Result<Vec<String>, String> {
    let out = hid_cmd("git").args(["-C", &path]).args(args)
      .output().map_err(|e| format!("git: {}", e))?;
    let s = String::from_utf8(out.stdout).map_err(|_| String::from("git: utf8 error"))?;
    Ok(s.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
  };
  let mut local = branches(&["branch"])?;
  let remote = branches(&["branch", "-r"]).unwrap_or_default();
  let current = local.iter().find_map(|b| {
    if b.starts_with("* ") { Some(b[2..].to_string()) } else { None }
  }).unwrap_or_default();
  local = local.into_iter().map(|b| if b.starts_with("* ") { b[2..].to_string() } else { b.to_string() }).collect();
  let mut result: Vec<Vec<String>> = local.into_iter().map(|b| {
    vec![if b == current { "local*".into() } else { "local".into() }, b]
  }).collect();
  for r in remote {
    result.push(vec!["remote".into(), r]);
  }
  Ok(result)
}

// ══════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════

#[tauri::command]
fn log_error(msg: String, stack: String) {
  eprintln!("[JS ERROR] {}", msg);
  for line in stack.lines() {
    eprintln!("  {}", line);
  }
}

fn main() {
  std::panic::set_hook(Box::new(|panic_info| {
    let msg = format!("[PANIC] {}", panic_info);
    eprintln!("{}", msg);
    let path = std::env::temp_dir().join("pill_terminal.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
      let _ = writeln!(f, "{}", msg);
    }
  }));
  eprintln!("[DEBUG] PillLauncher starting...");
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_clipboard_manager::init())
    .plugin(tauri_plugin_store::Builder::default().build())
      .setup(|app| {
        // Each terminal tab gets its own pipe-based PowerShell process.
        // For TTY-dependent tools like codex, use winpty (install via UI).
        app.manage(Mutex::new(HashMap::<String, TerminalSession>::new()));
        Ok(())
      })
    .invoke_handler(tauri::generate_handler![
      detect_project, run_cmd, stop_cmd, suspend_cmd, resume_cmd,
      read_file, save_file, list_dir,
      git_status, git_branches, git_checkout, git_pull, git_push,
      git_fetch, git_commit, git_add, git_add_all, git_unstage,
      git_stash, git_stash_pop, git_diff, git_remote_url,
      search_files, log_error, resolve_bp_class,
      start_terminal, write_terminal, stop_terminal, set_terminal_size, launch_external_terminal
    ])
    .run(tauri::generate_context!())
    .expect("PillLauncher failed to start");
}
