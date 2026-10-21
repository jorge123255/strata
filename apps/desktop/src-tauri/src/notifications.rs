//! Native notifications share Strata's process and bundle identity. Only the private host bridge calls this module.
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};
// Keep an early/cold-start click until the renderer has mounted. A wake event
// and the periodic check race safely: only one consumes the destination.
struct PendingOpen { destination: Value, expires: Option<Instant> }
static PENDING_OPEN: Mutex<Option<PendingOpen>> = Mutex::new(None);
fn pending_destination(value: Option<PendingOpen>, now: Instant) -> Option<Value> {
    value.filter(|pending| pending.expires.map_or(true, |expires| now < expires)).map(|pending| pending.destination)
}
pub fn take_open() -> Value { json!({"destination": pending_destination(PENDING_OPEN.lock().ok().and_then(|mut value| value.take()), Instant::now())}) }
pub fn clear_companion_open() { if let Ok(mut pending) = PENDING_OPEN.lock() { if pending.as_ref().is_some_and(|value| value.expires.is_some()) { *pending = None; } } }
static CONTEXT: Mutex<Option<Value>> = Mutex::new(None);
pub fn set_context(value: &Value) -> bool {
    if !value.as_object().is_some_and(|v| v.len() == 2) || !value["hash"].as_str().is_some_and(|s| s.starts_with("#/") && s.len() <= 4096 && !s.contains('\0')) || !(value["destination"].is_null() || valid_destination(&value["destination"])) { return false; }
    if let Ok(mut context) = CONTEXT.lock() { *context = Some(value.clone()); return true; }
    false
}
fn matches_focused_context(value: &Value, context: Option<&Value>, focused: bool, fragment: Option<&str>) -> bool {
    focused && context.is_some_and(|c| c["destination"] == value["destination"] && c["hash"].as_str().and_then(|s| s.strip_prefix('#')) == fragment && !c["destination"].is_null())
}

pub fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 200 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}
fn valid_destination(value: &Value) -> bool {
    value.as_object().is_some_and(|v| v.len() == 2)
        && matches!(value["type"].as_str(), Some("chat" | "team"))
        && value["id"].as_str().is_some_and(valid_id)
}
fn valid_open_destination(value: &Value) -> bool {
    valid_destination(value) || value == &json!({"type":"notifications","id":"settings"}) || value == &json!({"type":"bots","id":"activity"})
}
/// The companion can only open an exact chat or the fixed Activity page.
/// This does not expand the general notification delivery destinations.
pub fn open_companion_destination(value: &Value) -> bool {
    if !valid_companion_destination(value) { return false; }
    platform::open(value.clone(), true); true
}
fn valid_companion_destination(value: &Value) -> bool { valid_destination(value) && value["type"] == "chat" || value == &json!({"type":"bots","id":"activity"}) }
pub fn test_notification(sound: bool) -> Value {
    // A narrow diagnostic, not a journal message or a model turn. Text and
    // destination are fixed here instead of being supplied by an HTTP caller.
    platform::deliver(&json!({"id":"strata-notification-test","title":"Strata notifications","body":"Notifications are ready. Your bots can reach you here.","destination":{"type":"notifications","id":"settings"},"sound":sound}))
}
pub fn valid_delivery(value: &Value) -> bool {
    value.as_object().is_some_and(|v| v.len() == 5)
        && value["id"].as_str().is_some_and(valid_id)
        && [(&value["title"], 200), (&value["body"], 1000)].into_iter().all(|(v, max)| v.as_str().is_some_and(|s| !s.is_empty() && s.chars().count() <= max && !s.contains('\0')))
        && valid_destination(&value["destination"]) && value["sound"].is_boolean()
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::ffi::{c_char, CStr, CString};
    use std::sync::OnceLock;
    use tauri::{AppHandle, Manager};
    static APP: OnceLock<AppHandle> = OnceLock::new();
    extern "C" {
        fn strata_notifications_init(callback: extern "C" fn(*const c_char));
        fn strata_notifications_status() -> *mut c_char;
        fn strata_notifications_permission() -> *mut c_char;
        fn strata_notifications_deliver(value: *const c_char) -> *mut c_char;
        fn strata_notifications_free(value: *mut c_char);
        fn strata_notifications_focused() -> bool;
    }
    extern "C" fn clicked(raw: *const c_char) {
        if raw.is_null() { return; }
        let Ok(value) = serde_json::from_slice::<Value>(unsafe { CStr::from_ptr(raw).to_bytes() }) else { return; };
        if !valid_open_destination(&value) { return; }
        open(value, false);
    }
    pub fn open(value: Value, companion: bool) {
        if let Ok(mut pending) = PENDING_OPEN.lock() { *pending = Some(PendingOpen { destination: value, expires: companion.then(|| Instant::now() + Duration::from_secs(15)) }); }
        if let Some(app) = APP.get() {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus();
                let _ = window.eval("window.dispatchEvent(new Event('strata:notification-open'));" );
            }
        }
    }
    pub fn init(app: &AppHandle) { let _ = APP.set(app.clone()); unsafe { strata_notifications_init(clicked); } }
    unsafe fn result(raw: *mut c_char) -> Value {
        if raw.is_null() { return json!({"available":false,"detail":"macOS notifications are unavailable."}); }
        let value = serde_json::from_slice(CStr::from_ptr(raw).to_bytes()).unwrap_or(json!({"available":false}));
        strata_notifications_free(raw); value
    }
    pub fn status() -> Value { unsafe { result(strata_notifications_status()) } }
    pub fn permission() -> Value { unsafe { result(strata_notifications_permission()) } }
    pub fn deliver(value: &Value) -> Value {
        if let Some(window) = APP.get().and_then(|app| app.get_webview_window("main")) {
            let focused = window.is_focused().unwrap_or(false) && unsafe { strata_notifications_focused() };
            if let (Ok(context), Ok(url)) = (CONTEXT.lock(), window.url()) {
                if matches_focused_context(value, context.as_ref(), focused, url.fragment()) { return json!({"delivered":false,"handled":true,"detail":"This conversation is already visible."}); }
            }
        }
        let Ok(raw) = CString::new(value.to_string()) else { return json!({"delivered":false}); };
        unsafe { result(strata_notifications_deliver(raw.as_ptr())) }
    }
}
#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;
    pub fn init(_: &tauri::AppHandle) {}
    pub fn open(value: Value, companion: bool) { if let Ok(mut pending) = PENDING_OPEN.lock() { *pending = Some(PendingOpen { destination: value, expires: companion.then(|| Instant::now() + Duration::from_secs(15)) }); } }
    pub fn status() -> Value { json!({"available":false,"authorization":"unavailable","detail":"Native notifications are available in the Strata Mac app."}) }
    pub fn permission() -> Value { status() }
    pub fn deliver(_: &Value) -> Value { json!({"delivered":false}) }
}
pub use platform::{deliver, init, permission, status};

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn destinations_cannot_execute_code_or_open_urls() {
        for id in ["", "a/b", "https://example.test", "x' );alert(1)", "\n"] { assert!(!valid_destination(&json!({"type":"chat","id":id}))); }
        assert!(valid_destination(&json!({"type":"team","id":"t_example-12"})));
        assert!(!valid_destination(&json!({"type":"approval","id":"x"})));
        assert!(!valid_destination(&json!({"type":"chat","id":"x","action":"approve"})));
        assert!(valid_open_destination(&json!({"type":"notifications","id":"settings"})));
        assert!(!valid_open_destination(&json!({"type":"notifications","id":"anything-else"})));
        assert!(!valid_destination(&json!({"type":"notifications","id":"settings"})), "The test destination is never a general message destination.");
    }
    #[test] fn delivery_is_bounded_and_only_navigates() {
        let mut value = json!({"id":"n:1","title":"TEST","body":"New reply","destination":{"type":"chat","id":"c1"},"sound":true});
        assert!(valid_delivery(&value)); value["body"] = json!("x".repeat(1001)); assert!(!valid_delivery(&value));
        value["body"] = json!("hi"); value["command"] = json!("approve"); assert!(!valid_delivery(&value));
    }
    #[test] fn early_click_waits_for_renderer_and_is_consumed_once() {
        let destination = json!({"type":"chat","id":"retained-chat"});
        *PENDING_OPEN.lock().unwrap() = Some(PendingOpen { destination: destination.clone(), expires: None });
        assert_eq!(take_open()["destination"], destination);
        assert!(take_open()["destination"].is_null());
    }
    #[test] fn only_the_exact_visible_native_focused_conversation_is_suppressed() {
        let event = json!({"destination":{"type":"chat","id":"c1"}});
        let context = json!({"destination":{"type":"chat","id":"c1"},"hash":"#/bots/b1"});
        assert!(matches_focused_context(&event, Some(&context), true, Some("/bots/b1")));
        assert!(!matches_focused_context(&event, Some(&context), false, Some("/bots/b1")));
        assert!(!matches_focused_context(&event, Some(&context), true, Some("/bots/b2")));
        assert!(!matches_focused_context(&event, None, true, Some("/bots/b1")));
        assert!(!matches_focused_context(&json!({"destination":{"type":"chat","id":"c2"}}), Some(&context), true, Some("/bots/b1")));
    }
    #[test] fn context_cannot_supply_an_action_or_a_navigation_script() {
        assert!(set_context(&json!({"destination":null,"hash":"#/bots/teams"})));
        assert!(!set_context(&json!({"destination":{"type":"chat","id":"x"},"hash":"javascript:alert(1)"})));
        assert!(!set_context(&json!({"destination":{"type":"chat","id":"x"},"hash":"#/chat/x","approve":true})));
    }
    #[test] fn companion_navigation_has_no_approval_or_arbitrary_page_authority() {
        assert!(valid_companion_destination(&json!({"type":"chat","id":"s_exact-worker"})));
        assert!(valid_companion_destination(&json!({"type":"bots","id":"activity"})));
        for value in [json!({"type":"approval","id":"x"}), json!({"type":"team","id":"x"}), json!({"type":"bots","id":"settings"}), json!({"type":"chat","id":"https://example.test"}), json!({"type":"chat","id":"x","approve":true})] { assert!(!valid_companion_destination(&value)); }
        assert!(!valid_delivery(&json!({"id":"n1","title":"x","body":"x","destination":{"type":"bots","id":"activity"},"sound":false})));
    }
    #[test] fn companion_clicks_expire_without_expiring_existing_notification_clicks() {
        let now = Instant::now(); let chat = json!({"type":"chat","id":"s_exact"});
        assert_eq!(pending_destination(Some(PendingOpen { destination: chat.clone(), expires: Some(now + Duration::from_secs(1)) }), now), Some(chat.clone()));
        assert!(pending_destination(Some(PendingOpen { destination: chat.clone(), expires: Some(now) }), now).is_none());
        assert_eq!(pending_destination(Some(PendingOpen { destination: chat.clone(), expires: None }), now + Duration::from_secs(60)), Some(chat));
    }
}
