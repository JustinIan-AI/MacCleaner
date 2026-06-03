use tauri::Manager;
use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Start Go backend as sidecar
            let sidecar = app
                .shell()
                .sidecar("mole-tool")
                .expect("failed to create sidecar command");
            let (_rx, _child) = sidecar
                .spawn()
                .expect("failed to spawn Go backend sidecar");

            // Give the Go server a moment to start
            std::thread::sleep(std::time::Duration::from_millis(1500));

            // Navigate the WebView to the Go server
            if let Some(window) = app.get_webview_window("main") {
                let url = "http://localhost:4399"
                    .parse::<tauri::Url>()
                    .expect("invalid URL");
                let _ = window.navigate(url);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
