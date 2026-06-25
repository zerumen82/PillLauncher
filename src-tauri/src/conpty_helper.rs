//! ConPTY helper — CONSOLE subsystem process that creates a ConPTY
//! and forwards I/O between its own stdin/stdout and a child process.
//! This runs as a subprocess of the main GUI app so that the ConPTY
//! always has a console available (STATUS_DLL_INIT_FAILED workaround).

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: conpty_helper <program> [args...]");
        std::process::exit(1);
    }

    let shell_prog = &args[1];
    let shell_args = &args[2..];
    let cmd_line = format!("{} {}", shell_prog, shell_args.join(" "));

    unsafe {
        let mut sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: TRUE,
        };
        let mut in_r = std::ptr::null_mut();
        let mut in_w = std::ptr::null_mut();
        if CreatePipe(&mut in_r, &mut in_w, &mut sa as *mut SECURITY_ATTRIBUTES as *mut std::ffi::c_void, 0) == 0 {
            eprintln!("CreatePipe input failed: {}", GetLastError());
            std::process::exit(1);
        }

        let mut out_r = std::ptr::null_mut();
        let mut out_w = std::ptr::null_mut();
        if CreatePipe(&mut out_r, &mut out_w, &mut sa as *mut SECURITY_ATTRIBUTES as *mut std::ffi::c_void, 0) == 0 {
            eprintln!("CreatePipe output failed: {}", GetLastError());
            std::process::exit(1);
        }

        let mut h_pc = std::ptr::null_mut();
        let hr = CreatePseudoConsole(COORD { X: 80, Y: 24 }, in_r, out_w, 0, &mut h_pc);
        if hr != 0 {
            eprintln!("CreatePseudoConsole failed: {}", hr);
            std::process::exit(1);
        }

        CloseHandle(in_r);
        CloseHandle(out_w);

        let mut attr_size: usize = 0;
        InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attr_size);
        let attr_layout = std::alloc::Layout::from_size_align(attr_size, 8).unwrap();
        let attr_list = std::alloc::alloc_zeroed(attr_layout);
        if InitializeProcThreadAttributeList(attr_list as *mut std::ffi::c_void, 1, 0, &mut attr_size) == 0 {
            ClosePseudoConsole(h_pc);
            std::process::exit(1);
        }

        let mut pc = h_pc;
        UpdateProcThreadAttribute(
            attr_list as *mut std::ffi::c_void, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            &mut pc as *mut *mut std::ffi::c_void as *const std::ffi::c_void,
            std::mem::size_of::<*mut std::ffi::c_void>(), std::ptr::null_mut(), std::ptr::null_mut(),
        );

        let mut cmd_wide = to_wide(&cmd_line);
        let mut si: STARTUPINFOEXW = std::mem::zeroed();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.lpAttributeList = attr_list as *mut std::ffi::c_void;

        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessW(
            std::ptr::null_mut(),
            cmd_wide.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            EXTENDED_STARTUPINFO_PRESENT,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut si.StartupInfo,
            &mut pi,
        );

        DeleteProcThreadAttributeList(attr_list as *mut std::ffi::c_void);
        std::alloc::dealloc(attr_list, attr_layout);

        if ok == 0 {
            let err = GetLastError();
            eprintln!("CreateProcessW: {}", err);
            ClosePseudoConsole(h_pc);
            std::process::exit(1);
        }

        CloseHandle(pi.hThread);

        struct SendHandle(isize);
        unsafe impl Send for SendHandle {}
        impl SendHandle {
            fn from_h(h: HANDLE) -> Self { Self(h as isize) }
            fn to_h(&self) -> HANDLE { self.0 as isize as *mut std::ffi::c_void }
        }

        let stdin_h = SendHandle::from_h(GetStdHandle(STD_INPUT_HANDLE));
        let stdout_h = SendHandle::from_h(GetStdHandle(STD_OUTPUT_HANDLE));
        let in_w_h = SendHandle::from_h(in_w);
        let out_r_h = SendHandle::from_h(out_r);

        // Thread: stdin → pipe write end
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                let mut n = 0u32;
                let ok = ReadFile(stdin_h.to_h(), buf.as_mut_ptr() as *mut std::ffi::c_void, 4096, &mut n, std::ptr::null_mut());
                if ok == 0 || n == 0 { break; }
                let mut written = 0u32;
                WriteFile(in_w_h.to_h(), buf.as_ptr() as *const std::ffi::c_void, n, &mut written, std::ptr::null_mut());
            }
            let _ = CloseHandle(in_w_h.to_h());
        });

        // Thread: pipe read end → stdout
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                let mut n = 0u32;
                let ok = ReadFile(out_r_h.to_h(), buf.as_mut_ptr() as *mut std::ffi::c_void, 4096, &mut n, std::ptr::null_mut());
                if ok == 0 || n == 0 { break; }
                let mut written = 0u32;
                WriteFile(stdout_h.to_h(), buf.as_ptr() as *const std::ffi::c_void, n, &mut written, std::ptr::null_mut());
            }
            let _ = CloseHandle(out_r_h.to_h());
        });

        WaitForSingleObject(pi.hProcess, u32::MAX);
        let mut code: u32 = 0;
        GetExitCodeProcess(pi.hProcess, &mut code);
        CloseHandle(pi.hProcess);
        ClosePseudoConsole(h_pc);
        std::process::exit(code as i32);
    }
}

// ── Win32 FFI ──
type DWORD = u32;
type BOOL = i32;
type HANDLE = *mut std::ffi::c_void;
type LPCVOID = *const std::ffi::c_void;
type LPVOID = *mut std::ffi::c_void;
type LPDWORD = *mut u32;
type LPCSTR = *const u8;
type LPCWSTR = *const u16;
type LPWSTR = *mut u16;
// type LPSECURITY_ATTRIBUTES = *mut std::ffi::c_void;
type HPCON = HANDLE;

const TRUE: BOOL = 1;
const FALSE: BOOL = 0;
const EXTENDED_STARTUPINFO_PRESENT: DWORD = 0x00080000;
const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: DWORD = 0x00020016;
const STD_INPUT_HANDLE: DWORD = 0xFFFFFFF6u32;
const STD_OUTPUT_HANDLE: DWORD = 0xFFFFFFF5u32;

#[repr(C)]
struct COORD { X: i16, Y: i16 }

#[repr(C)]
struct SECURITY_ATTRIBUTES {
    nLength: DWORD,
    lpSecurityDescriptor: LPVOID,
    bInheritHandle: BOOL,
}

#[repr(C)]
struct STARTUPINFOW {
    cb: DWORD,
    lpReserved: LPWSTR,
    lpDesktop: LPWSTR,
    lpTitle: LPWSTR,
    dwX: DWORD,
    dwY: DWORD,
    dwXSize: DWORD,
    dwYSize: DWORD,
    dwXCountChars: DWORD,
    dwYCountChars: DWORD,
    dwFillAttribute: DWORD,
    dwFlags: DWORD,
    wShowWindow: u16,
    cbReserved2: u16,
    lpReserved2: *mut u8,
    hStdInput: HANDLE,
    hStdOutput: HANDLE,
    hStdError: HANDLE,
}

#[repr(C)]
struct STARTUPINFOEXW {
    StartupInfo: STARTUPINFOW,
    lpAttributeList: LPVOID,
}

#[repr(C)]
struct PROCESS_INFORMATION {
    hProcess: HANDLE,
    hThread: HANDLE,
    dwProcessId: DWORD,
    dwThreadId: DWORD,
}

extern "system" {
    fn CreatePipe(phReadPipe: *mut HANDLE, phWritePipe: *mut HANDLE, lpPipeAttributes: LPVOID, nSize: DWORD) -> BOOL;
    fn CloseHandle(hObject: HANDLE) -> BOOL;
    fn GetLastError() -> DWORD;
    fn CreatePseudoConsole(size: COORD, hInput: HANDLE, hOutput: HANDLE, dwFlags: DWORD, phPC: *mut HPCON) -> i32;
    fn ClosePseudoConsole(hPC: HPCON);
    fn InitializeProcThreadAttributeList(lpAttributeList: LPVOID, dwAttributeCount: DWORD, dwFlags: DWORD, lpSize: *mut usize) -> BOOL;
    fn UpdateProcThreadAttribute(lpAttributeList: LPVOID, dwFlags: DWORD, Attribute: DWORD, lpValue: LPCVOID, cbSize: usize, lpPreviousValue: LPVOID, lpReturnSize: *mut usize) -> BOOL;
    fn DeleteProcThreadAttributeList(lpAttributeList: LPVOID) -> ();
    fn CreateProcessW(lpApplicationName: LPCWSTR, lpCommandLine: LPWSTR, lpProcessAttributes: LPVOID, lpThreadAttributes: LPVOID, bInheritHandles: BOOL, dwCreationFlags: DWORD, lpEnvironment: LPVOID, lpCurrentDirectory: LPCWSTR, lpStartupInfo: *mut STARTUPINFOW, lpProcessInformation: *mut PROCESS_INFORMATION) -> BOOL;
    fn GetStdHandle(nStdHandle: DWORD) -> HANDLE;
    fn ReadFile(hFile: HANDLE, lpBuffer: LPVOID, nNumberOfBytesToRead: DWORD, lpNumberOfBytesRead: LPDWORD, lpOverlapped: LPVOID) -> BOOL;
    fn WriteFile(hFile: HANDLE, lpBuffer: LPCVOID, nNumberOfBytesToWrite: DWORD, lpNumberOfBytesWritten: LPDWORD, lpOverlapped: LPVOID) -> BOOL;
    fn WaitForSingleObject(hHandle: HANDLE, dwMilliseconds: DWORD) -> DWORD;
    fn GetExitCodeProcess(hProcess: HANDLE, lpExitCode: LPDWORD) -> BOOL;
}
