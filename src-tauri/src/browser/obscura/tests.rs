//! Obscura 引擎的纯逻辑单测(不启动进程/不连 CDP)。

use super::live::valid_key;

#[test]
fn valid_key_rejects_path_traversal_and_accepts_safe() {
    assert!(valid_key("ai"));
    assert!(valid_key("web:abc-123"));
    assert!(valid_key("a-b"));
    assert!(!valid_key(".."));
    assert!(!valid_key("..%2f"));
    assert!(!valid_key("a/b"));
    assert!(!valid_key(""));
    assert!(!valid_key("A")); // 大小写混合拒绝
}
