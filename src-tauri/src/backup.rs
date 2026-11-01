use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const MAX_BACKUP_BYTES: usize = 8 * 1024 * 1024;

fn safe_filename(raw: &str) -> Option<String> {
    let name = raw.trim();
    if name.is_empty()
        || name.len() > 120
        || !name.starts_with("seeworld-backup-")
        || !name.ends_with(".json")
        || name.contains("..")
    {
        return None;
    }
    if !name
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return None;
    }
    Some(name.to_string())
}

fn backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = app.path().download_dir() {
        if !dir.as_os_str().is_empty() {
            return Ok(dir);
        }
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位备份目录：{error}"))?;
    Ok(dir.join("backups"))
}

/// 直接写文件，避免 WebView2 的原生下载提示。
/// 文件名由前端生成但在这里白名单校验，不接受任意路径。
#[tauri::command]
pub fn export_backup(app: AppHandle, data: String, file_name: String) -> Result<String, String> {
    if data.trim().is_empty() {
        return Err("备份内容为空".to_string());
    }
    if data.len() > MAX_BACKUP_BYTES {
        return Err("备份内容过大".to_string());
    }
    let file_name =
        safe_filename(&file_name).ok_or_else(|| "备份文件名不合法".to_string())?;
    let dir = backup_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建备份目录失败：{error}"))?;
    let path = dir.join(file_name);
    std::fs::write(&path, data.as_bytes()).map_err(|error| format!("写入备份失败：{error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::safe_filename;

    #[test]
    fn accepts_generated_backup_names() {
        assert!(safe_filename("seeworld-backup-2026-11-02T07-00-00-000Z.json").is_some());
        assert!(safe_filename("seeworld-backup-manual_test.json").is_some());
    }

    #[test]
    fn rejects_paths_and_unexpected_names() {
        assert!(safe_filename("../seeworld-backup-a.json").is_none());
        assert!(safe_filename("seeworld-backup-a/../b.json").is_none());
        assert!(safe_filename("other.json").is_none());
        assert!(safe_filename("seeworld-backup-a.exe").is_none());
        assert!(safe_filename("").is_none());
    }
}