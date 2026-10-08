//! 会话注册表(StarHub × dsh 联动,契约 §2.1 / §4 ssh_attach/ssh_detach)——
//! 从 `src-tauri/src/registry.rs` 平移(去 Tauri 化 M1,纯逻辑零改动)。
//!
//! 维护「assetId → 附着条目」视图:条目记录复用的 SSH sessionId、附着引用
//! 计数与附着方清单(attachedBy)。SshManager 仍是 session 实体唯一所有者,
//! 本表只是其上的附着语义层;快照时以 SshManager 的存活 session 集合为准
//! 剔除断线条目(断线 = 注册表变更,调用方负责发 `starhub/registry.sync`)。
//!
//! 本批只纳入 SSH(kind="ssh");kind 字段已为 SFTP/DB 预留。
//!
//! 另含「资产页面开窗注册表」(open.asset/focus.tool 的 action 预判用):
//! 旧 detach 实例窗口机制已随 P4a 退役;sidecar 侧按 (assetId, tool) 做
//! best-effort 记录——首次请求视为 open,之后视为 focus;窗口实际关闭无回报名
//! (本批契约未覆盖),记录可能滞后,仅影响 action 文案。新架构里开窗/聚焦是
//! bridge 插件事件(工作台面板),这里只保留预判语义。

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

/// 注册表快照条目(契约 §2.1 starhub/registry.sync 的 sessions 元素)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySession {
    pub asset_id: String,
    pub session_id: String,
    /// 会话种类:"ssh" | "sftp" | "db"(本批只有 ssh,字段预留)。
    pub kind: String,
    /// 附着方标识清单(本批固定 "frontend";后续可有 "dsh" / "agent" 等)。
    pub attached_by: Vec<String>,
}

/// 单资产附着条目。
#[derive(Debug, Clone)]
struct Attachment {
    session_id: String,
    kind: String,
    /// 附着引用计数:detach 减一,归零才真正断开 session。
    refcount: u32,
    attached_by: Vec<String>,
}

/// detach 结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetachOutcome {
    /// session 不在注册表中(幂等场景由调用方决定是否报错)。
    NotTracked,
    /// 计数减一后仍有附着方,session 保持连接。
    StillAttached { asset_id: String, refcount: u32 },
    /// 计数归零,条目已移除,调用方应真正断开 session。
    Removed { asset_id: String },
}

pub struct SessionRegistry {
    /// assetId → 附着条目(一个资产一条后端 session,多方附着复用)。
    attachments: Mutex<HashMap<String, Attachment>>,
    /// 已请求打开的资产页面:(assetId, tool);open.asset/focus.tool 的 action 预判。
    opened_pages: Mutex<HashSet<(String, String)>>,
}

impl Default for SessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            attachments: Mutex::new(HashMap::new()),
            opened_pages: Mutex::new(HashSet::new()),
        }
    }

    /// 附着:已有条目则计数+1(返回 true 表示复用),否则新建条目。
    /// 同一 caller 重复附着不重复计入 attachedBy(计数照样 +1,detach 对称减)。
    pub fn attach(&self, asset_id: &str, session_id: &str, kind: &str, caller: &str) -> bool {
        let mut attachments = self.attachments.lock().unwrap();
        match attachments.get_mut(asset_id) {
            Some(entry) if entry.session_id == session_id => {
                entry.refcount += 1;
                if !entry.attached_by.iter().any(|c| c == caller) {
                    entry.attached_by.push(caller.to_string());
                }
                true
            }
            _ => {
                attachments.insert(
                    asset_id.to_string(),
                    Attachment {
                        session_id: session_id.to_string(),
                        kind: kind.to_string(),
                        refcount: 1,
                        attached_by: vec![caller.to_string()],
                    },
                );
                false
            }
        }
    }

    /// 按 sessionId 减计数;归零时移除条目(调用方据此真正断开)。
    pub fn detach(&self, session_id: &str, caller: &str) -> DetachOutcome {
        let mut attachments = self.attachments.lock().unwrap();
        let Some(asset_id) = attachments
            .iter()
            .find(|(_, entry)| entry.session_id == session_id)
            .map(|(asset_id, _)| asset_id.clone())
        else {
            return DetachOutcome::NotTracked;
        };
        let entry = attachments.get_mut(&asset_id).expect("刚定位的条目");
        if let Some(pos) = entry.attached_by.iter().position(|c| c == caller) {
            entry.attached_by.remove(pos);
        }
        entry.refcount = entry.refcount.saturating_sub(1);
        if entry.refcount == 0 {
            attachments.remove(&asset_id);
            DetachOutcome::Removed { asset_id }
        } else {
            DetachOutcome::StillAttached {
                asset_id,
                refcount: entry.refcount,
            }
        }
    }

    /// 按 sessionId 强制移除条目(断线/显式 disconnect 时调用),返回资产 id。
    pub fn remove_session(&self, session_id: &str) -> Option<String> {
        let mut attachments = self.attachments.lock().unwrap();
        let asset_id = attachments
            .iter()
            .find(|(_, entry)| entry.session_id == session_id)
            .map(|(asset_id, _)| asset_id.clone())?;
        attachments.remove(&asset_id);
        Some(asset_id)
    }

    /// 资产的既有附着 sessionId(不校验存活,存活判定由调用方查 SshManager)。
    pub fn session_for_asset(&self, asset_id: &str) -> Option<String> {
        self.attachments
            .lock()
            .unwrap()
            .get(asset_id)
            .map(|entry| entry.session_id.clone())
    }

    /// sessionId 反查资产 id(live.snapshot 的 transfers 映射 assetId 用)。
    pub fn asset_for_session(&self, session_id: &str) -> Option<String> {
        self.attachments
            .lock()
            .unwrap()
            .iter()
            .find(|(_, entry)| entry.session_id == session_id)
            .map(|(asset_id, _)| asset_id.clone())
    }

    /// 全量快照:以存活 session 集合为准剔除断线条目。
    /// 返回 (快照, 是否发生了剔除);剔除意味着注册表变更,调用方应发 registry.sync。
    pub fn snapshot(&self, live_sessions: &HashSet<String>) -> (Vec<RegistrySession>, bool) {
        let mut attachments = self.attachments.lock().unwrap();
        let dead: Vec<String> = attachments
            .iter()
            .filter(|(_, entry)| !live_sessions.contains(&entry.session_id))
            .map(|(asset_id, _)| asset_id.clone())
            .collect();
        let pruned = !dead.is_empty();
        for asset_id in dead {
            attachments.remove(&asset_id);
        }
        let sessions = attachments
            .iter()
            .map(|(asset_id, entry)| RegistrySession {
                asset_id: asset_id.clone(),
                session_id: entry.session_id.clone(),
                kind: entry.kind.clone(),
                attached_by: entry.attached_by.clone(),
            })
            .collect();
        (sessions, pruned)
    }

    /// 开窗注册表:首次返回 "open" 并记录,之后返回 "focus"
    /// (open.asset / focus.tool 的 action 预判;见模块注释的滞后性说明)。
    pub fn open_or_focus(&self, asset_id: &str, tool: &str) -> &'static str {
        let mut pages = self.opened_pages.lock().unwrap();
        if pages.insert((asset_id.to_string(), tool.to_string())) {
            "open"
        } else {
            "focus"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attach_reuses_existing_entry_with_refcount() {
        let registry = SessionRegistry::new();
        assert!(!registry.attach("a1", "a1-shared", "ssh", "frontend"));
        assert_eq!(
            registry.session_for_asset("a1").as_deref(),
            Some("a1-shared")
        );
        // 再次附着:复用 + 计数 2
        assert!(registry.attach("a1", "a1-shared", "ssh", "frontend"));
        // 新 caller 计入 attachedBy
        assert!(registry.attach("a1", "a1-shared", "ssh", "dsh"));
        let live: HashSet<String> = ["a1-shared".to_string()].into_iter().collect();
        let (snapshot, pruned) = registry.snapshot(&live);
        assert!(!pruned);
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].asset_id, "a1");
        assert_eq!(snapshot[0].session_id, "a1-shared");
        assert_eq!(snapshot[0].kind, "ssh");
        assert_eq!(snapshot[0].attached_by, vec!["frontend", "dsh"]);
    }

    #[test]
    fn detach_decrements_and_removes_at_zero() {
        let registry = SessionRegistry::new();
        registry.attach("a1", "s1", "ssh", "frontend");
        registry.attach("a1", "s1", "ssh", "dsh");

        assert_eq!(
            registry.detach("s1", "frontend"),
            DetachOutcome::StillAttached {
                asset_id: "a1".into(),
                refcount: 1
            }
        );
        assert_eq!(
            registry.detach("s1", "dsh"),
            DetachOutcome::Removed {
                asset_id: "a1".into()
            }
        );
        assert_eq!(registry.session_for_asset("a1"), None);
        assert_eq!(registry.detach("s1", "frontend"), DetachOutcome::NotTracked);
    }

    #[test]
    fn remove_session_untracks_entry() {
        let registry = SessionRegistry::new();
        registry.attach("a1", "s1", "ssh", "frontend");
        assert_eq!(registry.remove_session("s1").as_deref(), Some("a1"));
        assert_eq!(registry.remove_session("s1"), None);
        assert_eq!(registry.session_for_asset("a1"), None);
    }

    #[test]
    fn snapshot_prunes_dead_sessions_and_reports_change() {
        let registry = SessionRegistry::new();
        registry.attach("a1", "s1", "ssh", "frontend");
        registry.attach("a2", "s2", "ssh", "frontend");

        let live: HashSet<String> = ["s2".to_string()].into_iter().collect();
        let (snapshot, pruned) = registry.snapshot(&live);
        assert!(pruned, "剔除断线条目 = 注册表变更");
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].asset_id, "a2");
        assert_eq!(registry.session_for_asset("a1"), None, "死条目应被移除");

        let (snapshot, pruned) = registry.snapshot(&live);
        assert!(!pruned, "再次快照无变更");
        assert_eq!(snapshot.len(), 1);
    }

    #[test]
    fn open_or_focus_transitions() {
        let registry = SessionRegistry::new();
        assert_eq!(registry.open_or_focus("a1", "auto"), "open");
        assert_eq!(registry.open_or_focus("a1", "auto"), "focus");
        // 不同 tool 独立计数
        assert_eq!(registry.open_or_focus("a1", "terminal"), "open");
        assert_eq!(registry.open_or_focus("a2", "auto"), "open");
    }

    #[test]
    fn registry_session_serializes_camel_case() {
        let session = RegistrySession {
            asset_id: "a1".into(),
            session_id: "s1".into(),
            kind: "ssh".into(),
            attached_by: vec!["frontend".into()],
        };
        let value = serde_json::to_value(&session).expect("serialize");
        assert_eq!(value["assetId"], "a1");
        assert_eq!(value["sessionId"], "s1");
        assert_eq!(value["attachedBy"], serde_json::json!(["frontend"]));
    }
}
