//! SFTP 管理器(Tauri 侧适配层,去 Tauri 化 M1):域逻辑(传输/枚举/会话)在
//! `starhub-domain-ssh` crate,本模块再导出其 `sftp` 公共面(含
//! FileEntry / TransferTask / TransferProgress 等类型),
//! `crate::sftp::*` 路径对既有调用方不变。

pub use starhub_domain_ssh::sftp::*;
