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

        // SwiftUI is linked into the same Strata executable. No helper app,
        // framework bundle, extra executable or additional signing identity.
        let swift_files = ["CompanionAvatar.swift", "KoalaGeometry.swift", "AvatarCharacterGeometry.swift", "SVGPath.swift", "CompanionModel.swift", "CompanionFeed.swift", "CompanionMotion.swift", "CompanionPanel.swift"];
        let swift_library = out.join("libstrata_companion.a");
        let mut swift = std::process::Command::new("/usr/bin/xcrun");
        swift.args(["swiftc", "-target", &format!("{arch}-apple-macosx15.0"), "-parse-as-library", "-emit-library", "-static", "-O", "-module-name", "StrataCompanion", "-o"]).arg(&swift_library);
        for file in swift_files {
            let source = format!("src/companion/{file}"); swift.arg(&source); println!("cargo:rerun-if-changed={source}");
        }
        assert!(swift.status().expect("compile same-process native bot companion").success());
        let sdk = std::process::Command::new("/usr/bin/xcrun").arg("--show-sdk-path").output().expect("macOS SDK path");
        assert!(sdk.status.success());
        let sdk = String::from_utf8(sdk.stdout).expect("SDK path encoding");
        let compiler = std::process::Command::new("/usr/bin/xcrun").args(["--find", "swiftc"]).output().expect("Swift compiler path");
        assert!(compiler.status.success());
        let compiler = String::from_utf8(compiler.stdout).expect("Swift path encoding");
        let runtime = std::path::Path::new(compiler.trim()).parent().expect("Swift bin").parent().expect("Swift usr").join("lib/swift/macosx");
        println!("cargo:rustc-link-search=native={}/usr/lib/swift", sdk.trim());
        println!("cargo:rustc-link-search=native={}", runtime.display());
        println!("cargo:rustc-link-lib=static=strata_companion");
        // Mach-O autolink records in the Swift archive bind its actual Swift
        // runtime libraries. macOS 15 supplies the runtime in /usr/lib/swift.
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        for framework in ["SwiftUI", "Combine", "Foundation", "CoreFoundation", "CoreGraphics", "QuartzCore"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
    tauri_build::build()
}
