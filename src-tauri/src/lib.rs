use log::{error, info};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DirectoryContents {
    pub entries: Vec<FileEntry>,
    pub path: String,
}

#[tauri::command]
fn read_directory(path: String) -> Result<DirectoryContents, String> {
    let path = PathBuf::from(&path);

    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }

    if !path.is_dir() {
        return Err(format!("Path is not a directory: {}", path.display()));
    }

    let mut entries = Vec::new();
    let dir_entries = fs::read_dir(&path)
        .map_err(|error| format!("Failed to read directory {}: {}", path.display(), error))?;

    for entry in dir_entries {
        match entry {
            Ok(entry) => {
                let metadata = entry.metadata().ok();
                let modified = metadata
                    .as_ref()
                    .and_then(|details| details.modified().ok())
                    .and_then(|timestamp| timestamp.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs());

                entries.push(FileEntry {
                    name: entry.file_name().to_string_lossy().to_string(),
                    path: entry.path().to_string_lossy().to_string(),
                    is_dir: metadata.as_ref().map(|details| details.is_dir()).unwrap_or(false),
                    size: metadata.as_ref().map(|details| details.len()).unwrap_or(0),
                    modified,
                });
            }
            Err(error) => error!("Error reading entry in {}: {}", path.display(), error),
        }
    }

    Ok(DirectoryContents {
        entries,
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn get_drives() -> Result<Vec<String>, String> {
    let mut drives = Vec::new();

    #[cfg(target_os = "windows")]
    {
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if PathBuf::from(&drive).exists() {
                drives.push(drive);
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        drives.push("/".to_string());
    }

    Ok(drives)
}

#[tauri::command]
fn copy_file(source: String, destination: String) -> Result<(), String> {
    let source_path = PathBuf::from(&source);
    let destination_path = PathBuf::from(&destination);

    ensure_copyable(&source_path, &destination_path)?;
    copy_entry_recursive(&source_path, &destination_path)
        .map_err(|error| format!("Failed to copy {}: {}", source_path.display(), error))
}

#[tauri::command]
fn move_file(source: String, destination: String) -> Result<(), String> {
    let source_path = PathBuf::from(&source);
    let destination_path = PathBuf::from(&destination);

    ensure_copyable(&source_path, &destination_path)?;
    create_parent_directory(&destination_path)
        .map_err(|error| format!("Failed to prepare destination: {}", error))?;

    match fs::rename(&source_path, &destination_path) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            copy_entry_recursive(&source_path, &destination_path).map_err(|copy_error| {
                format!(
                    "Failed to move {}: {}. Fallback copy also failed: {}",
                    source_path.display(),
                    rename_error,
                    copy_error
                )
            })?;
            delete_path(&source_path)
                .map_err(|error| format!("Copied, but failed to remove source: {}", error))
        }
    }
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    delete_path(Path::new(&path)).map_err(|error| format!("Failed to delete {}: {}", path, error))
}

#[tauri::command]
fn rename_file(old_path: String, new_name: String) -> Result<String, String> {
    let old_path = PathBuf::from(&old_path);
    let parent = old_path.parent().ok_or("No parent directory")?;
    let new_path = parent.join(&new_name);

    if new_path.exists() && new_path != old_path {
        return Err(format!("Destination already exists: {}", new_path.display()));
    }

    fs::rename(&old_path, &new_path)
        .map_err(|error| format!("Failed to rename {}: {}", old_path.display(), error))?;

    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
fn create_directory(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|error| format!("Failed to create directory {}: {}", path, error))
}

fn ensure_copyable(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Err(format!("Source does not exist: {}", source.display()));
    }

    if destination.exists() {
        return Err(format!(
            "Destination already exists: {}",
            destination.display()
        ));
    }

    create_parent_directory(destination)
        .map_err(|error| format!("Failed to prepare destination: {}", error))
}

fn create_parent_directory(destination: &Path) -> io::Result<()> {
    if let Some(parent) = destination.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }

    Ok(())
}

fn copy_entry_recursive(source: &Path, destination: &Path) -> io::Result<()> {
    if source.is_dir() {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_entry_recursive(&entry.path(), &destination.join(entry.file_name()))?;
        }
        return Ok(());
    }

    create_parent_directory(destination)?;
    fs::copy(source, destination)?;
    Ok(())
}

fn delete_path(path: &Path) -> io::Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    info!("Starting I Love Norton Commander");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            read_directory,
            get_drives,
            copy_file,
            move_file,
            delete_file,
            rename_file,
            create_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
