// Tauri lib shim — thin wrapper so the library crate is well-formed.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Binary entry point is main.rs; this file exists only to keep the lib target valid.
  // Commands are defined in main.rs where they are registered by generate_handler!.
}
