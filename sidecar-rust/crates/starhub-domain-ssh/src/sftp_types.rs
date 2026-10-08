use serde::{Deserialize, Serialize};

/// SFTP 目录项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    /// 文件/目录名(不含父路径)
    pub name: String,
    /// 完整绝对路径
    pub path: String,
    /// 是否是目录
    pub is_dir: bool,
    /// 文件大小(字节),目录为 0
    pub size: u64,
    /// 修改时间(Unix timestamp 毫秒)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<u64>,
    /// POSIX 权限位(0o755 = 493)
    pub permissions: u32,
    /// Unix owner uid(可选)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid: Option<u32>,
    /// Unix group gid(可选)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gid: Option<u32>,
}
