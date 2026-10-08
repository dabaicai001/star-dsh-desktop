//! 会话 → 资产绑定(从 `src-tauri/src/harness/mod.rs::HostBridgeState` 的绑定
//! 逻辑平移,去 Tauri 化 M1;纯逻辑零改动)。
//!
//! dsh 侧 `bind_asset_context` / `open_connection` 把「当前会话 @ 了哪个资产」
//! 记在这里;域工具执行时若参数没带 assetId,就沿 subagent 父链向上解析
//! (子代理会话继承父会话绑定)。环引用(异常通知)以 visited 集防御。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

/// 会话绑定表:session_id → (资产类型, 资产 id)。
#[derive(Default)]
pub struct SessionBindings {
    bindings: Mutex<HashMap<String, (String, String)>>,
    /// subagent 子 → 父会话映射。
    subagent_parents: Mutex<HashMap<String, String>>,
}

impl SessionBindings {
    pub fn new() -> Self {
        Self::default()
    }

    /// 记录 会话→资产 绑定;asset_id 为空视为解除绑定。
    pub fn bind(&self, session_id: &str, asset_type: &str, asset_id: &str) {
        let mut bindings = self.bindings.lock().unwrap();
        if asset_id.trim().is_empty() {
            bindings.remove(session_id);
        } else {
            bindings.insert(
                session_id.to_string(),
                (asset_type.to_string(), asset_id.to_string()),
            );
        }
    }

    /// 记录 subagent 子→父会话映射(子代理会话继承父会话的资产绑定)。
    pub fn record_subagent_parent(&self, child_session_id: &str, parent_session_id: &str) {
        self.subagent_parents
            .lock()
            .unwrap()
            .insert(child_session_id.to_string(), parent_session_id.to_string());
    }

    /// 沿 subagent 父链向上解析会话的资产绑定(子代理继承父会话绑定);
    /// 无绑定返回 None。环引用(异常通知)以 visited 集防御。
    pub fn resolve(&self, session_id: &str) -> Option<(String, String)> {
        let mut current = session_id.to_string();
        let mut visited = HashSet::new();
        loop {
            if let Some(binding) = self.bindings.lock().unwrap().get(&current) {
                return Some(binding.clone());
            }
            if !visited.insert(current.clone()) {
                return None;
            }
            let parent = self.subagent_parents.lock().unwrap().get(&current)?.clone();
            current = parent;
        }
    }

    /// 解除一个会话的绑定(会话结束/切换资产时)。
    pub fn unbind(&self, session_id: &str) {
        self.bindings.lock().unwrap().remove(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_and_resolve_roundtrip() {
        let bindings = SessionBindings::new();
        assert_eq!(bindings.resolve("root"), None);
        bindings.bind("root", "ssh", "a1");
        assert_eq!(bindings.resolve("root"), Some(("ssh".into(), "a1".into())));
        // 空 asset_id = 解绑
        bindings.bind("root", "ssh", "");
        assert_eq!(bindings.resolve("root"), None);
    }

    #[test]
    fn subagent_child_inherits_parent_binding() {
        let bindings = SessionBindings::new();
        bindings.bind("root", "db", "db-1");
        bindings.record_subagent_parent("child-1", "root");
        bindings.record_subagent_parent("child-2", "child-1");
        assert_eq!(
            bindings.resolve("child-2"),
            Some(("db".into(), "db-1".into()))
        );
        // 子会话自己的绑定优先于父链
        bindings.bind("child-1", "ssh", "ssh-1");
        assert_eq!(
            bindings.resolve("child-2"),
            Some(("ssh".into(), "ssh-1".into()))
        );
    }

    #[test]
    fn cycle_is_terminated_by_the_visited_set() {
        let bindings = SessionBindings::new();
        bindings.record_subagent_parent("a", "b");
        bindings.record_subagent_parent("b", "a");
        assert_eq!(bindings.resolve("a"), None);
    }

    #[test]
    fn unbind_only_removes_the_target_session() {
        let bindings = SessionBindings::new();
        bindings.bind("root", "ssh", "a1");
        bindings.record_subagent_parent("child", "root");
        bindings.unbind("child");
        assert_eq!(bindings.resolve("child"), Some(("ssh".into(), "a1".into())));
        bindings.unbind("root");
        assert_eq!(bindings.resolve("child"), None);
    }
}
