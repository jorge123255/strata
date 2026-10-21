fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
        let arch = std::env::var("CARGO_CFG_TARGET_ARCH").expect("target arch");
        let arch = if arch == "aarch64" { "arm64" } else { &arch };
        let object = out.join("notifications.o");
        assert!(std::process::Command::new("/usr/bin/xcrun").args(["clang", "-fobjc-arc", "-fblocks", "-mmacosx-version-min=15.0", "-arch", arch, "-c", "src/notifications.m", "-o"]).arg(&object).status().expect("compile native notifications").success());
        assert!(std::process::Command::new("/usr/bin/ar").arg("rcs").arg(out.join("libstrata_notifications.a")).arg(object).status().expect("archive native notifications").success());
        println!("cargo:rustc-link-search=native={}", out.display());
        println!("cargo:rustc-link-lib=static=strata_notifications");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rerun-if-changed=src/notifications.m");
    }
    tauri_build::build()
}
