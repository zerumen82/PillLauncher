use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::ffi::OsStringExt;
use std::path::Path;
use std::ptr;

const WINPTY_FLAG_COLOR_ESCAPES: u64 = 0x4;
const WINPTY_SPAWN_FLAG_AUTO_SHUTDOWN: u64 = 1;
const GENERIC_READ: u32 = 0x80000000;
const GENERIC_WRITE: u32 = 0x40000000;

pub struct Winpty {
    lib: libloading::Library,
    winpty_t: *mut c_void,
    conin: std::fs::File,
    conout: std::fs::File,
    proc_handle: isize,
}

impl Winpty {
    pub fn open(dll_path: &Path, cols: i32, rows: i32) -> Result<Self, String> {
        let lib = unsafe { libloading::Library::new(dll_path) }
            .map_err(|e| format!("Cannot load winpty.dll: {}", e))?;

        // Load function pointers
        let config_new: libloading::Symbol<unsafe extern "C" fn(u64, *mut *mut c_void) -> *mut c_void> =
            unsafe { lib.get(b"winpty_config_new") }
                .map_err(|e| format!("winpty_config_new: {}", e))?;

        let config_set_initial_size: libloading::Symbol<unsafe extern "C" fn(*mut c_void, i32, i32)> =
            unsafe { lib.get(b"winpty_config_set_initial_size") }
                .map_err(|e| format!("winpty_config_set_initial_size: {}", e))?;

        let config_free: libloading::Symbol<unsafe extern "C" fn(*mut c_void)> =
            unsafe { lib.get(b"winpty_config_free") }
                .map_err(|e| format!("winpty_config_free: {}", e))?;

        let open_fn: libloading::Symbol<unsafe extern "C" fn(*const c_void, *mut *mut c_void) -> *mut c_void> =
            unsafe { lib.get(b"winpty_open") }
                .map_err(|e| format!("winpty_open: {}", e))?;

        let free_fn: libloading::Symbol<unsafe extern "C" fn(*mut c_void)> =
            unsafe { lib.get(b"winpty_free") }
                .map_err(|e| format!("winpty_free: {}", e))?;

        let error_msg: libloading::Symbol<unsafe extern "C" fn(*mut c_void) -> *const u16> =
            unsafe { lib.get(b"winpty_error_msg") }
                .map_err(|e| format!("winpty_error_msg: {}", e))?;

        let error_free: libloading::Symbol<unsafe extern "C" fn(*mut c_void)> =
            unsafe { lib.get(b"winpty_error_free") }
                .map_err(|e| format!("winpty_error_free: {}", e))?;

        // Create config
        let mut err: *mut c_void = ptr::null_mut();
        let cfg = unsafe { config_new(WINPTY_FLAG_COLOR_ESCAPES, &mut err) };
        if cfg.is_null() {
            let msg = unsafe { get_winpty_err_msg(err, &error_msg, &error_free) };
            return Err(format!("winpty_config_new failed: {}", msg));
        }

        unsafe { config_set_initial_size(cfg, cols, rows) };

        // Open winpty
        let mut err: *mut c_void = ptr::null_mut();
        let wp = unsafe { open_fn(cfg, &mut err) };
        unsafe { config_free(cfg) };

        if wp.is_null() {
            let msg = unsafe { get_winpty_err_msg(err, &error_msg, &error_free) };
            return Err(format!("winpty_open failed: {}", msg));
        }

        // Get pipe names
        let conin_name_fn: libloading::Symbol<unsafe extern "C" fn(*mut c_void) -> *const u16> =
            unsafe { lib.get(b"winpty_conin_name") }
                .map_err(|e| format!("winpty_conin_name: {}", e))?;

        let conout_name_fn: libloading::Symbol<unsafe extern "C" fn(*mut c_void) -> *const u16> =
            unsafe { lib.get(b"winpty_conout_name") }
                .map_err(|e| format!("winpty_conout_name: {}", e))?;

        let conin_path_ptr = unsafe { conin_name_fn(wp) };
        let conout_path_ptr = unsafe { conout_name_fn(wp) };

        if conin_path_ptr.is_null() || conout_path_ptr.is_null() {
            unsafe { free_fn(wp) };
            return Err("winpty_conin_name/conout_name returned null".into());
        }

        let conin_path = unsafe { std::ffi::OsString::from_wide(std::slice::from_raw_parts(conin_path_ptr, {
            let mut len = 0;
            while *conin_path_ptr.add(len) != 0 { len += 1; }
            len
        })) };
        let conout_path = unsafe { std::ffi::OsString::from_wide(std::slice::from_raw_parts(conout_path_ptr, {
            let mut len = 0;
            while *conout_path_ptr.add(len) != 0 { len += 1; }
            len
        })) };

        // Connect to named pipes
        use std::os::windows::io::FromRawHandle;

        let connect_pipe = |name: &std::ffi::OsStr, desired_access: u32| -> Result<std::fs::File, String> {
            let wide: Vec<u16> = name.encode_wide().chain(std::iter::once(0)).collect();
            unsafe {
                let h = windows::Win32::Storage::FileSystem::CreateFileW(
                    windows::core::PCWSTR::from_raw(wide.as_ptr()),
                    desired_access,
                    windows::Win32::Storage::FileSystem::FILE_SHARE_READ | windows::Win32::Storage::FileSystem::FILE_SHARE_WRITE,
                    None,
                    windows::Win32::Storage::FileSystem::OPEN_EXISTING,
                    windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0),
                    None,
                ).map_err(|e| format!("CreateFileW failed for pipe: {:?}", e))?;
                Ok(std::fs::File::from_raw_handle(h.0))
            }
        };

        let conin_file = connect_pipe(&conin_path, GENERIC_WRITE)?;
        let conout_file = connect_pipe(&conout_path, GENERIC_READ)?;

        Ok(Winpty {
            lib,
            winpty_t: wp,
            conin: conin_file,
            conout: conout_file,
            proc_handle: 0,
        })
    }

    pub fn spawn(&mut self, appname: Option<&str>, cmdline: &str, cwd: &str) -> Result<u32, String> {
        let spawn_config_new: libloading::Symbol<unsafe extern "C" fn(u64, *const u16, *const u16, *const u16, *const u16, *mut *mut c_void) -> *mut c_void> =
            unsafe { self.lib.get(b"winpty_spawn_config_new") }
                .map_err(|e| format!("winpty_spawn_config_new: {}", e))?;

        let spawn_config_free: libloading::Symbol<unsafe extern "C" fn(*mut c_void)> =
            unsafe { self.lib.get(b"winpty_spawn_config_free") }
                .map_err(|e| format!("winpty_spawn_config_free: {}", e))?;

        let spawn_fn: libloading::Symbol<unsafe extern "C" fn(*mut c_void, *const c_void, *mut isize, *mut isize, *mut u32, *mut *mut c_void) -> i32> =
            unsafe { self.lib.get(b"winpty_spawn") }
                .map_err(|e| format!("winpty_spawn: {}", e))?;

        let error_msg: libloading::Symbol<unsafe extern "C" fn(*mut c_void) -> *const u16> =
            unsafe { self.lib.get(b"winpty_error_msg") }
                .map_err(|e| format!("winpty_error_msg: {}", e))?;

        let error_free: libloading::Symbol<unsafe extern "C" fn(*mut c_void)> =
            unsafe { self.lib.get(b"winpty_error_free") }
                .map_err(|e| format!("winpty_error_free: {}", e))?;

        use std::os::windows::ffi::OsStrExt;

        let appname_wide = appname.map(|s| std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>());
        let cmdline_wide: Vec<u16> = std::ffi::OsStr::new(cmdline).encode_wide().chain(std::iter::once(0)).collect();
        let cwd_wide: Vec<u16> = std::ffi::OsStr::new(cwd).encode_wide().chain(std::iter::once(0)).collect();

        let appname_ptr = appname_wide.as_ref().map(|v| v.as_ptr()).unwrap_or(std::ptr::null());

        let mut err: *mut c_void = ptr::null_mut();
        let spawn_cfg = unsafe {
            spawn_config_new(
                WINPTY_SPAWN_FLAG_AUTO_SHUTDOWN,
                appname_ptr,
                cmdline_wide.as_ptr(),
                cwd_wide.as_ptr(),
                ptr::null(),
                &mut err,
            )
        };

        if spawn_cfg.is_null() {
            let msg = unsafe { get_winpty_err_msg(err, &error_msg, &error_free) };
            return Err(format!("winpty_spawn_config_new failed: {}", msg));
        }

        let mut proc_handle: isize = 0;
        let mut thread_handle: isize = 0;
        let mut create_process_error: u32 = 0;
        let mut err: *mut c_void = ptr::null_mut();

        let result = unsafe {
            spawn_fn(
                self.winpty_t,
                spawn_cfg,
                &mut proc_handle,
                &mut thread_handle,
                &mut create_process_error,
                &mut err,
            )
        };

        unsafe { spawn_config_free(spawn_cfg) };

        if result == 0 {
            let msg = if !err.is_null() {
                unsafe { get_winpty_err_msg(err, &error_msg, &error_free) }
            } else {
                format!("CreateProcess failed: error code {}", create_process_error)
            };
            return Err(format!("winpty_spawn failed: {}", msg));
        }

        self.proc_handle = proc_handle;

        let child_pid = unsafe {
            windows::Win32::System::Threading::GetProcessId(windows::Win32::Foundation::HANDLE(proc_handle as *mut c_void))
        };

        Ok(child_pid)
    }

    #[allow(dead_code)]
    pub fn conin(&self) -> &std::fs::File { &self.conin }
    #[allow(dead_code)]
    pub fn conout(&self) -> &std::fs::File { &self.conout }
    #[allow(dead_code)]
    pub fn conin_mut(&mut self) -> &mut std::fs::File { &mut self.conin }
    #[allow(dead_code)]
    pub fn conout_mut(&mut self) -> &mut std::fs::File { &mut self.conout }
    #[allow(dead_code)]
    pub fn proc_handle(&self) -> isize { self.proc_handle }

    pub fn into_parts(mut self) -> WinptyParts {
        let parts = unsafe {
            WinptyParts {
                lib: std::ptr::read(&self.lib),
                winpty_t: self.winpty_t,
                conin: std::ptr::read(&self.conin),
                conout: std::ptr::read(&self.conout),
                proc_handle: self.proc_handle,
            }
        };
        self.winpty_t = std::ptr::null_mut();
        std::mem::forget(self);
        parts
    }
}

impl Drop for Winpty {
    fn drop(&mut self) {
        if !self.winpty_t.is_null() {
            if let Ok(free_fn) = unsafe { self.lib.get::<unsafe extern "C" fn(*mut c_void)>(b"winpty_free") } {
                unsafe { free_fn(self.winpty_t) };
            }
        }
    }
}

pub struct WinptyParts {
    pub lib: libloading::Library,
    pub winpty_t: *mut c_void,
    pub conin: std::fs::File,
    pub conout: std::fs::File,
    pub proc_handle: isize,
}

unsafe fn get_winpty_err_msg(err: *mut c_void, msg_fn: &libloading::Symbol<unsafe extern "C" fn(*mut c_void) -> *const u16>, free_fn: &libloading::Symbol<unsafe extern "C" fn(*mut c_void)>) -> String {
    if err.is_null() { return "unknown error".into(); }
    let msg_ptr = unsafe { msg_fn(err) };
    let msg = if !msg_ptr.is_null() {
        let len = (0..).take_while(|&i| *msg_ptr.add(i) != 0).count();
        String::from_utf16_lossy(std::slice::from_raw_parts(msg_ptr, len))
    } else {
        "unknown error".into()
    };
    unsafe { free_fn(err) };
    msg
}
