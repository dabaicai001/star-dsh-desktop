package adapters

import (
	"reflect"
	"testing"
	"time"
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

// SET 的可选选项必须被解析:旧版只取 parts[1..2],`SET k v EX 60` 的 EX 60
// 被静默丢掉,key 被写成永不过期,TTL 语义与用户意图相反。
func TestParseSetOptionsExpiration(t *testing.T) {
	cases := []struct {
		name   string
		tokens []string
		want   time.Duration
	}{
		{"no options", nil, 0},
		{"EX seconds", []string{"EX", "60"}, 60 * time.Second},
		{"PX milliseconds", []string{"PX", "1500"}, 1500 * time.Millisecond},
		{"lowercase ex", []string{"ex", "30"}, 30 * time.Second},
		{"EXAT future", []string{"EXAT", "99999999999"}, time.Until(time.Unix(99999999999, 0))},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, errMsg := parseSetOptions(tc.tokens)
			if errMsg != "" {
				t.Fatalf("parseSetOptions(%v) error = %q, want none", tc.tokens, errMsg)
			}
			if got.expiration != tc.want {
				t.Fatalf("parseSetOptions(%v).expiration = %v, want %v", tc.tokens, got.expiration, tc.want)
			}
			if got.keepTTL || got.nx || got.xx {
				t.Fatalf("parseSetOptions(%v) set unexpected flags: %+v", tc.tokens, got)
			}
		})
	}
}

func TestParseSetOptionsFlags(t *testing.T) {
	got, errMsg := parseSetOptions([]string{"NX", "KEEPTTL"})
	if errMsg != "" {
		t.Fatalf("parseSetOptions(NX KEEPTTL) error = %q, want none", errMsg)
	}
	if !got.nx || !got.keepTTL || got.xx {
		t.Fatalf("parseSetOptions(NX KEEPTTL) = %+v, want nx+keepTTL", got)
	}
	if got.expiration != 0 {
		t.Fatalf("parseSetOptions(NX KEEPTTL).expiration = %v, want 0", got.expiration)
	}

	got, errMsg = parseSetOptions([]string{"XX"})
	if errMsg != "" {
		t.Fatalf("parseSetOptions(XX) error = %q, want none", errMsg)
	}
	if !got.xx || got.nx {
		t.Fatalf("parseSetOptions(XX) = %+v, want xx only", got)
	}
}

func TestParseSetOptionsRejectsInvalid(t *testing.T) {
	cases := []struct {
		name   string
		tokens []string
		want   string
	}{
		{"missing EX arg", []string{"EX"}, "SET EX requires an argument"},
		{"zero EX", []string{"EX", "0"}, "invalid EX seconds: 0"},
		{"negative EX", []string{"EX", "-1"}, "invalid EX seconds: -1"},
		{"non-numeric EX", []string{"EX", "abc"}, "invalid EX seconds: abc"},
		{"non-numeric PX", []string{"PX", "abc"}, "invalid PX milliseconds: abc"},
		{"non-numeric EXAT", []string{"EXAT", "abc"}, "invalid EXAT timestamp: abc"},
		{"non-numeric PXAT", []string{"PXAT", "abc"}, "invalid PXAT timestamp: abc"},
		{"unsupported option", []string{"IDLE", "5"}, "unsupported SET option: IDLE"},
		{"EX with KEEPTTL", []string{"EX", "60", "KEEPTTL"}, "SET cannot use both EX/PX and KEEPTTL"},
		{"NX with XX", []string{"NX", "XX"}, "SET cannot use both NX and XX"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, errMsg := parseSetOptions(tc.tokens)
			if errMsg != tc.want {
				t.Fatalf("parseSetOptions(%v) error = %q, want %q", tc.tokens, errMsg, tc.want)
			}
		})
	}
}
