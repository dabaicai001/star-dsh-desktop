package adapters

import (
	"reflect"
	"testing"
)

func TestParseRedisCommandSplitsTokens(t *testing.T) {
	got := parseRedisCommand(`HSET user:1 name alice`)
	want := []string{"HSET", "user:1", "name", "alice"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseRedisCommand() = %v, want %v", got, want)
	}
}

// 空引用串(`""`)必须保留为一个空 token:Hash/List 成员值可为空字符串,
// redisQuote("") 生成 `""`,丢弃会导致 HSET/LSET 参数不足报错。
func TestParseRedisCommandKeepsEmptyQuotedToken(t *testing.T) {
	got := parseRedisCommand(`HSET user:1 note ""`)
	want := []string{"HSET", "user:1", "note", ""}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseRedisCommand() = %v, want %v", got, want)
	}
	// 单 HSET 应得到 4 个 token(含空值),满足 (len(parts)-2)%2 == 0。
	if len(got)%2 != 0 || len(got) < 4 {
		t.Fatalf("HSET token count = %d, unbalanced or too few", len(got))
	}
}

func TestParseRedisCommandHandlesQuotedFieldWithSpaces(t *testing.T) {
	got := parseRedisCommand(`HSET user:1 "display name" "alice smith"`)
	want := []string{"HSET", "user:1", "display name", "alice smith"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseRedisCommand() = %v, want %v", got, want)
	}
}

// HSET 单对 field/value 必须被接受(旧版 `(len(parts)-1)%2` 让单对恒报
// "HSET requires key field value")。此处只校验 token 层面:
// key 之后的 token 数应为偶数。
func TestHsetTokensBalanced(t *testing.T) {
	for _, cmd := range []string{
		`HSET h a 1`,
		`HSET h a 1 b 2`,
		`HSET h a ""`,
	} {
		parts := parseRedisCommand(cmd)
		if len(parts) < 4 {
			t.Fatalf("HSET %q has too few tokens: %d", cmd, len(parts))
		}
		if (len(parts)-2)%2 != 0 {
			t.Fatalf("HSET %q field/value tokens unbalanced: %d", cmd, len(parts))
		}
	}
}
