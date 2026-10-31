#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod anich;
mod douban;
mod play;
mod play_proxy;

use tauri::Manager;

fn main() {
    eprintln!("[jianjie] app booting, registering commands…");
    tauri::Builder::default()
        .setup(|app| {
            // 任务栏/窗口图标以运行时设置为准,避免仍然显示旧的 N 图标。
            if let Ok(icon) = tauri::image::Image::from_app_icon_resource(128) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_icon(icon);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            douban::douban_list,
            douban::douban_suggest,
            douban::douban_detail,
            douban::douban_recommend,
            play::play_sources,
            play::play_probe,
            play::play_search,
            play::play_detail,
            play::play_resolve,
            anich::anime_danmaku,
            anich::set_network_proxy,
        ])
        .register_asynchronous_uri_scheme_protocol("dbimg", |_app, request, responder| {
            tauri::async_runtime::spawn(async move {
                let response = douban::fetch_image(request).await;
                responder.respond(response);
            });
        })
        .register_asynchronous_uri_scheme_protocol("jjstream", |context, request, responder| {
            let app: tauri::AppHandle = context.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(play_proxy::handle(app, request).await);
            });
        })
        .run(tauri::generate_context!())
        .expect("error while running 见界");
}
