//! An optional native panel inside Strata, behind the existing private shell bridge.
//! It observes status and opens exact conversations; it cannot run or approve work.
use serde_json::{json, Value};

pub fn valid_screen(value: &str) -> bool {
    value == "main" || value.len() == 36 && value.bytes().enumerate().all(|(i, b)| {
        if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_digit() || (b'A'..=b'F').contains(&b) }
    })
}
pub fn valid_settings(value: &Value) -> bool {
    value.as_object().is_some_and(|v| !v.is_empty() && v.len() <= 2 && v.iter().all(|(key, value)| match key.as_str() {
        "enabled" => value.is_boolean(), "screen" => value.as_str().is_some_and(valid_screen), _ => false,
    }))
}
pub fn settings(value: &Value) -> Value {
    if !valid_settings(value) { return json!({"available":cfg!(target_os="macos"),"error":"Choose valid companion settings."}); }
    platform::settings(value)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::ffi::{c_char, CStr, CString};
    extern "C" {
        fn strata_companion_init(callback: extern "C" fn(*const c_char));
        fn strata_companion_configure(port: u16, token: *const c_char);
        fn strata_companion_shutdown();
        fn strata_companion_status() -> *mut c_char;
        fn strata_companion_settings(value: *const c_char) -> *mut c_char;
        fn strata_companion_free(value: *mut c_char);
    }
    extern "C" fn clicked(raw: *const c_char) {
        if raw.is_null() { return; }
        // Native callbacks are synchronous, typed destinations. No URLs,
        // JavaScript, approval decisions, or secret values cross this boundary.
        let bytes = unsafe { CStr::from_ptr(raw).to_bytes() };
        if bytes.len() > 512 { return; }
        if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
            let _ = crate::notifications::open_companion_destination(&value);
        }
    }
    pub fn init(_: &tauri::AppHandle) { unsafe { strata_companion_init(clicked) } }
    pub fn configure(port: u16, token: &str) {
        // Never persist or return this launch-scoped token. The native owner
        // copies it synchronously before returning from the C ABI function.
        if !(32..=200).contains(&token.len()) || !token.bytes().all(|b| b.is_ascii_alphanumeric()) { return; }
        crate::notifications::clear_companion_open();
        if let Ok(token) = CString::new(token) { unsafe { strata_companion_configure(port, token.as_ptr()) } }
    }
    pub fn shutdown() { unsafe { strata_companion_shutdown() } }
    unsafe fn result(raw: *mut c_char) -> Value {
        if raw.is_null() { return json!({"available":false,"detail":"The bot companion is unavailable."}); }
        let bytes = CStr::from_ptr(raw).to_bytes();
        let value = if bytes.len() <= 16384 { serde_json::from_slice(bytes).unwrap_or(json!({"available":false})) } else { json!({"available":false}) };
        strata_companion_free(raw); value
    }
    pub fn status() -> Value { unsafe { result(strata_companion_status()) } }
    pub fn settings(value: &Value) -> Value {
        let Ok(raw) = CString::new(value.to_string()) else { return json!({"available":false}); };
        let result = unsafe { result(strata_companion_settings(raw.as_ptr())) };
        if result["settings"]["enabled"] == false { crate::notifications::clear_companion_open(); }
        result
    }
}
#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;
    pub fn init(_: &tauri::AppHandle) {}
    pub fn configure(_: u16, _: &str) {}
    pub fn shutdown() {}
    pub fn status() -> Value { json!({"available":false,"settings":{"enabled":false,"screen":"main"},"screens":[],"visible":false,"expanded":false,"detail":"The native bot companion is available in the Strata Mac app."}) }
    pub fn settings(_: &Value) -> Value { status() }
}
pub use platform::{configure, init, shutdown, status};

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn settings_are_explicit_and_cannot_supply_authority_or_urls() {
        for value in [json!({}), json!([]), json!({"enabled":1}), json!({"screen":"https://example.test"}), json!({"enabled":true,"command":"approve"}), json!({"screen":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"})] { assert!(!valid_settings(&value)); }
        assert!(valid_settings(&json!({"enabled":true})));
        assert!(valid_settings(&json!({"enabled":false,"screen":"main"})));
        assert!(valid_settings(&json!({"screen":"12345678-ABCD-1234-ABCD-123456789012"})));
    }
    #[test] fn display_ids_are_canonical_and_do_not_encode_paths() {
        for value in ["", "MAIN", "main\0", "../main", "12345678-ABCD-1234-ABCD-12345678901Z", "12345678ABCD-1234-ABCD-123456789012"] { assert!(!valid_screen(value)); }
        assert!(valid_screen("main"));
    }
}
