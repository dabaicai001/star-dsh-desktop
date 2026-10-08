use anyhow::{Context, Result};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileAttributes;
use russh_sftp::protocol::OpenFlags;
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex;

use super::FileEntry;
use glob_match::glob_match;

fn metadata_to_entry(parent: &str, name: &str, meta: &FileAttributes) -> FileEntry {
    let is_dir = meta.is_dir();
    let is_symlink = meta.is_symlink();
    let size = meta.size.unwrap_or(0);
    let perms = meta.permissions.unwrap_or(0) & 0o777;
    let mtime = meta.mtime.unwrap_or(0);
    let path = if parent.is_empty() {
        name.to_string()
    } else if parent.ends_with('/') {
        format!("{}{}", parent, name)
    } else {
        format!("{}/{}", parent, name)
    };

    FileEntry {
        name: name.to_string(),
        path,
        is_dir,
        size,
        permissions: perms,
        modified: mtime as i64,
        is_symlink,
    }
}

async fn get_entry(sftp: &SftpSession, path: &str) -> Result<FileEntry> {
    let meta = sftp
        .metadata(path)
        .await
        .with_context(|| format!("stat failed: {}", path))?;
    let parent = Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    Ok(metadata_to_entry(&parent, &name, &meta))
}

pub async fn list_dir(sftp: &Arc<Mutex<SftpSession>>, path: &str) -> Result<Vec<FileEntry>> {
    let sftp = sftp.lock().await;
    let read_dir = sftp
        .read_dir(path)
        .await
        .with_context(|| format!("list_dir failed: {}", path))?;

    let mut entries: Vec<FileEntry> = read_dir
        .map(|entry| metadata_to_entry(path, &entry.file_name(), &entry.metadata()))
        .collect();

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

pub async fn stat(sftp: &Arc<Mutex<SftpSession>>, path: &str) -> Result<FileEntry> {
    let sftp = sftp.lock().await;
    get_entry(&sftp, path).await
}

pub async fn mkdir(sftp: &Arc<Mutex<SftpSession>>, path: &str) -> Result<()> {
    let sftp = sftp.lock().await;
    sftp.create_dir(path)
        .await
        .with_context(|| format!("mkdir failed: {}", path))?;
    Ok(())
}

#[allow(dead_code)]
pub async fn rename(sftp: &Arc<Mutex<SftpSession>>, from: &str, to: &str) -> Result<()> {
    let sftp = sftp.lock().await;
    sftp.rename(from, to)
        .await
        .with_context(|| format!("rename failed: {} -> {}", from, to))?;
    Ok(())
}

#[allow(dead_code)]
pub async fn delete_file(sftp: &Arc<Mutex<SftpSession>>, path: &str) -> Result<()> {
    let sftp = sftp.lock().await;
    sftp.remove_file(path)
        .await
        .with_context(|| format!("delete_file failed: {}", path))?;
    Ok(())
}

#[allow(dead_code)]
pub async fn delete_dir(sftp: &Arc<Mutex<SftpSession>>, path: &str) -> Result<()> {
    let sftp = sftp.lock().await;
    sftp.remove_dir(path)
        .await
        .with_context(|| format!("delete_dir failed: {}", path))?;
    Ok(())
}

#[allow(dead_code)]
pub async fn set_permissions(
    sftp: &Arc<Mutex<SftpSession>>,
    path: &str,
    permissions: u32,
) -> Result<()> {
    let sftp = sftp.lock().await;
    let meta = sftp
        .metadata(path)
        .await
        .with_context(|| format!("set_permissions stat failed: {}", path))?;

    let original_perms = meta.permissions.unwrap_or(0);
    let type_bits = original_perms & !0o7777;
    let new_perms = type_bits | (permissions & 0o7777);

    let mut attrs = FileAttributes::empty();
    attrs.permissions = Some(new_perms);

    sftp.set_metadata(path, attrs)
        .await
        .with_context(|| format!("set_permissions failed: {}", path))?;
    Ok(())
}

pub async fn upload_file<F, G, H>(
    sftp: &Arc<Mutex<SftpSession>>,
    local_path: &str,
    remote_path: &str,
    resume_from: u64,
    on_progress: F,
    get_speed_limit: G,
    is_cancelled: H,
) -> Result<()>
where
    F: Fn(u64, u64) + Send + 'static,
    G: Fn() -> u64 + Send + 'static,
    H: Fn() -> bool + Send + 'static,
{
    tracing::info!(
        "[upload_file] start: local={}, remote={}, resume_from={}",
        local_path,
        remote_path,
        resume_from
    );

    let total_size = tokio::fs::metadata(local_path)
        .await
        .with_context(|| format!("read local file failed: {}", local_path))?
        .len();

    tracing::info!("[upload_file] local file size: {} bytes", total_size);

    let mut local_file = tokio::fs::File::open(local_path)
        .await
        .with_context(|| format!("open local file failed: {}", local_path))?;

    if resume_from > 0 && resume_from >= total_size {
        anyhow::bail!(
            "resume_from ({}) >= file size ({})",
            resume_from,
            total_size
        );
    }

    let remote_file = {
        let sftp = sftp.lock().await;
        if resume_from > 0 {
            tracing::info!(
                "[upload_file] opening remote file for resume at {}: {}",
                resume_from,
                remote_path
            );
            sftp.open_with_flags(remote_path, OpenFlags::WRITE)
                .await
                .map_err(|e| {
                    anyhow::anyhow!(
                        "open remote file failed: {} (SFTP error: {})",
                        remote_path,
                        e
                    )
                })?
        } else {
            tracing::info!("[upload_file] creating remote file: {}", remote_path);
            sftp.create(remote_path).await.map_err(|e| {
                anyhow::anyhow!(
                    "create remote file failed: {} (SFTP error: {})",
                    remote_path,
                    e
                )
            })?
        }
    };

    let mut remote_file = remote_file;
    let mut buf = vec![0u8; 65536];
    let mut transferred: u64 = resume_from;
    let mut session_transferred: u64 = 0;
    let mut chunk_count: u64 = 0;

    if resume_from > 0 {
        remote_file
            .seek(std::io::SeekFrom::Start(resume_from))
            .await
            .with_context(|| "seek remote file failed")?;
        local_file
            .seek(std::io::SeekFrom::Start(resume_from))
            .await
            .with_context(|| "seek local file failed")?;
    }

    on_progress(transferred, total_size);

    let start_time = std::time::Instant::now();

    loop {
        // 取消检查:每 64KB 块一次,保证取消/暂停能中断单个大文件的传输
        if is_cancelled() {
            anyhow::bail!("transfer cancelled");
        }

        let n = local_file
            .read(&mut buf)
            .await
            .with_context(|| "read local chunk failed")?;
        if n == 0 {
            tracing::info!(
                "[upload_file] EOF reached after {} chunks, total {} bytes",
                chunk_count,
                transferred
            );
            break;
        }

        remote_file
            .write_all(&buf[..n])
            .await
            .with_context(|| format!("write remote chunk failed at offset {}", transferred))?;

        transferred += n as u64;
        session_transferred += n as u64;
        chunk_count += 1;
        if chunk_count <= 3 || chunk_count.is_multiple_of(100) {
            tracing::info!(
                "[upload_file] chunk {}: wrote {} bytes, total {} / {}",
                chunk_count,
                n,
                transferred,
                total_size
            );
        }
        on_progress(transferred, total_size);

        // Speed limit throttle
        let current_speed_limit = get_speed_limit();
        if let Some(expected_ms) = (session_transferred * 1000).checked_div(current_speed_limit) {
            let elapsed_ms = start_time.elapsed().as_millis() as u64;
            if expected_ms > elapsed_ms {
                tokio::time::sleep(tokio::time::Duration::from_millis(expected_ms - elapsed_ms))
                    .await;
            }
        }
    }

    tracing::info!("[upload_file] calling shutdown/flush...");
    remote_file
        .shutdown()
        .await
        .with_context(|| "flush remote file failed")?;

    tracing::info!("[upload_file] done: {} bytes uploaded", transferred);
    Ok(())
}

pub async fn download_file<F, G, H>(
    sftp: &Arc<Mutex<SftpSession>>,
    remote_path: &str,
    local_path: &str,
    resume_from: u64,
    on_progress: F,
    get_speed_limit: G,
    is_cancelled: H,
) -> Result<u64>
where
    F: Fn(u64, u64) + Send + 'static,
    G: Fn() -> u64 + Send + 'static,
    H: Fn() -> bool + Send + 'static,
{
    let mut remote_file = {
        let sftp = sftp.lock().await;
        sftp.open(remote_path).await.map_err(|e| {
            anyhow::anyhow!(
                "open remote file failed: {} (SFTP error: {})",
                remote_path,
                e
            )
        })?
    };

    // 某些远端存储/FUSE 在 open 后 fstat 仍可能失败,这里降级为 0 继续传输,
    // 最终返回实际读取到的字节数作为文件大小。
    let total_size = match remote_file.metadata().await {
        Ok(meta) => meta.size.unwrap_or(0),
        Err(e) => {
            tracing::warn!(
                "[download_file] fstat failed for {} after open: {}; continuing without total size",
                remote_path,
                e
            );
            0
        }
    };

    let open_opts = if resume_from > 0 {
        let mut opts = tokio::fs::OpenOptions::new();
        opts.write(true).read(true).create(true);
        opts
    } else {
        let mut opts = tokio::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        opts
    };

    // 本机目标目录可能不存在(AI 工具调用时 LLM 常给一个还没建的目录),先递归创建
    if let Some(parent) = std::path::Path::new(local_path).parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("create local dir failed: {}", parent.display()))?;
        }
    }

    let mut local_file = open_opts
        .open(local_path)
        .await
        .with_context(|| format!("open local file failed: {}", local_path))?;

    if resume_from > 0 {
        remote_file
            .seek(std::io::SeekFrom::Start(resume_from))
            .await
            .with_context(|| "seek remote file failed")?;
        local_file
            .seek(std::io::SeekFrom::Start(resume_from))
            .await
            .with_context(|| "seek local file failed")?;
    }

    let mut buf = vec![0u8; 65536];
    let mut transferred = resume_from;
    let mut session_transferred: u64 = 0;

    on_progress(transferred, total_size);

    let start_time = std::time::Instant::now();

    loop {
        // 取消检查:每 64KB 块一次,保证取消/暂停能中断单个大文件的传输
        if is_cancelled() {
            anyhow::bail!("transfer cancelled");
        }

        let n = remote_file
            .read(&mut buf)
            .await
            .with_context(|| "read remote chunk failed")?;
        if n == 0 {
            break;
        }

        local_file
            .write_all(&buf[..n])
            .await
            .with_context(|| "write local chunk failed")?;

        transferred += n as u64;
        session_transferred += n as u64;
        on_progress(transferred, total_size);

        // Speed limit throttle
        let current_speed_limit = get_speed_limit();
        if let Some(expected_ms) = (session_transferred * 1000).checked_div(current_speed_limit) {
            let elapsed_ms = start_time.elapsed().as_millis() as u64;
            if expected_ms > elapsed_ms {
                tokio::time::sleep(tokio::time::Duration::from_millis(expected_ms - elapsed_ms))
                    .await;
            }
        }
    }

    local_file
        .flush()
        .await
        .with_context(|| "flush local file failed")?;

    Ok(total_size.max(transferred))
}

#[allow(dead_code)]
pub async fn search_files(
    sftp: &Arc<Mutex<SftpSession>>,
    path: &str,
    pattern: &str,
) -> Result<Vec<FileEntry>> {
    let entries = list_dir(sftp, path).await.unwrap_or_default();
    let mut results = Vec::new();

    for entry in entries {
        let matched = glob_match(pattern, &entry.name);
        if matched {
            results.push(entry.clone());
        }

        if entry.is_dir {
            let sub_results = Box::pin(search_files(sftp, &entry.path, pattern)).await?;
            results.extend(sub_results);
        }
    }

    results.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(results)
}
