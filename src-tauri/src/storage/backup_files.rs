//! Bounded, non-following local backup I/O. Snapshot names never come from a caller.
use crate::storage::database::BackupFile;
use serde::Serialize;
#[cfg(test)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

pub const MAX_BACKUP_BYTES: u64 = 256 * 1024 * 1024;
static SERIAL: AtomicU64 = AtomicU64::new(0);
static SNAPSHOT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePoint {
    pub id: String,
    pub path: String,
    pub created_at: u64,
    pub bytes: u64,
}

fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

pub fn check_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.components().any(|p| matches!(p, Component::ParentDir)) {
        return Err("备份路径必须是无上级跳转的绝对路径".into());
    }
    #[cfg(windows)]
    {
        use std::path::Prefix;
        for part in path.components() {
            match part {
                Component::Prefix(prefix)
                    if !matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) =>
                {
                    return Err("备份仅允许本机磁盘路径".into())
                }
                Component::Normal(name) if name.to_string_lossy().contains(':') => {
                    return Err("备份路径不允许备用数据流".into())
                }
                _ => {}
            }
        }
    }
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(m) if linked(&m) => return Err("备份路径不允许符号链接或重解析点".into()),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("检查备份路径失败：{e}")),
        }
    }
    Ok(())
}

pub fn read_backup(path: &Path) -> Result<BackupFile, String> {
    check_path(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("读取备份文件失败：{e}"))?;
    if !metadata.is_file() || metadata.len() > MAX_BACKUP_BYTES {
        return Err("备份文件无效或超过 256 MiB 上限".into());
    }
    let mut raw = Vec::new();
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Open the reparse point itself rather than its target if the path is
        // swapped between our metadata check and open.
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let opened = file.metadata().map_err(|e| e.to_string())?;
    if linked(&opened) || !opened.is_file() || opened.len() > MAX_BACKUP_BYTES {
        return Err("备份文件不安全或过大".into());
    }
    file.take(MAX_BACKUP_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|e| e.to_string())?;
    if raw.len() as u64 > MAX_BACKUP_BYTES {
        return Err("备份文件超过 256 MiB 上限".into());
    }
    check_path(path)?;
    let mut backup: BackupFile =
        serde_json::from_slice(&raw).map_err(|e| format!("无法解析芝麻备份：{e}"))?;
    if backup.app != super::BACKUP_APP_MARKER
        || !(1..=super::BACKUP_FORMAT_VERSION).contains(&backup.format_version)
    {
        return Err("备份格式或版本不受支持，请升级应用".into());
    }
    if let Some(config) = &mut backup.config {
        config.validate()?;
        config.ui_preferences = config
            .ui_preferences
            .take()
            .map(crate::storage::database::backup_config::sanitize_preferences)
            .transpose()?;
    }
    backup.validate()?;
    Ok(backup)
}

pub fn write_backup(path: &Path, backup: &BackupFile, overwrite: bool) -> Result<u64, String> {
    check_path(path)?;
    let bytes = serde_json::to_vec(backup).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BACKUP_BYTES {
        return Err("备份超过 256 MiB 上限，未写入文件".into());
    }
    let parent = path.parent().ok_or("备份目录无效")?;
    let temp = parent.join(format!(
        ".zhima-backup-{}-{}.tmp",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| format!("创建备份失败：{e}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("写入备份失败：{e}"))?;
        drop(file);
        check_path(path)?;
        if !overwrite && path.exists() {
            return Err("恢复点已存在".into());
        }
        // rename replaces regular files atomically on supported local filesystems.
        fs::rename(&temp, path).map_err(|e| format!("完成备份文件失败：{e}"))?;
        Ok(bytes.len() as u64)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub fn snapshots_dir(app_data: &Path) -> Result<PathBuf, String> {
    check_path(app_data)?;
    let path = app_data.join("snapshots");
    check_path(&path)?;
    fs::create_dir_all(&path).map_err(|e| format!("创建恢复点目录失败：{e}"))?;
    check_path(&path)?;
    Ok(path)
}

fn list_unlocked(dir: &Path) -> Result<Vec<RestorePoint>, String> {
    check_path(dir)?;
    let mut points = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("snapshot-") || !name.ends_with(".json") {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if linked(&metadata) || !metadata.is_file() {
            return Err("恢复点目录含不安全文件".into());
        }
        let stamp = name
            .strip_prefix("snapshot-")
            .and_then(|s| s.split('-').next())
            .and_then(|s| s.parse::<u64>().ok())
            .ok_or("恢复点文件名无效")?;
        if metadata.len() > MAX_BACKUP_BYTES {
            return Err("恢复点超过大小上限".into());
        }
        points.push(RestorePoint {
            id: name,
            path: entry.path().to_string_lossy().into_owned(),
            created_at: stamp,
            bytes: metadata.len(),
        });
    }
    points.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(points)
}

pub fn list(dir: &Path) -> Result<Vec<RestorePoint>, String> {
    let _guard = SNAPSHOT_LOCK.lock().map_err(|_| "恢复点锁不可用")?;
    list_unlocked(dir)
}

pub fn create(dir: &Path, backup: &BackupFile) -> Result<RestorePoint, String> {
    let _guard = SNAPSHOT_LOCK.lock().map_err(|_| "恢复点锁不可用")?;
    let old = list_unlocked(dir)?;
    let now = crate::storage::config::now_millis();
    let id = format!(
        "snapshot-{now}-{:020}.json",
        SERIAL.fetch_add(1, Ordering::Relaxed)
    );
    let path = dir.join(&id);
    let bytes = write_backup(&path, backup, false)?;
    // If retention cannot be enforced, do not authorize destructive replace.
    for stale in old.iter().skip(4) {
        check_path(Path::new(&stale.path))?;
        fs::remove_file(&stale.path).map_err(|e| format!("清理恢复点失败，已禁止替换：{e}"))?;
    }
    Ok(RestorePoint {
        id,
        path: path.to_string_lossy().into_owned(),
        created_at: now,
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "zhima-backup-test-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn backup_recovery_retains_five_and_rejects_traversal() {
        let root = dir();
        let path = snapshots_dir(&root).unwrap();
        let db = crate::storage::database::Database::in_memory();
        let backup = db.export_backup(true).unwrap();
        for _ in 0..7 {
            create(&path, &backup).unwrap();
        }
        assert_eq!(list(&path).unwrap().len(), 5);
        assert!(read_backup(&path.join("../secret.json")).is_err());
        assert!(check_path(Path::new("relative.json")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn backup_rejects_oversized_file_before_reading() {
        let root = dir();
        let path = root.join("large.json");
        File::create(&path)
            .unwrap()
            .set_len(MAX_BACKUP_BYTES + 1)
            .unwrap();
        assert!(read_backup(&path).unwrap_err().contains("上限"));
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn backup_rejects_symlink() {
        let root = dir();
        let target = root.join("real");
        fs::write(&target, "{}").unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(target, &link).unwrap();
        assert!(read_backup(&link).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
