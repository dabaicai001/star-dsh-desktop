package adapters

import (
	"regexp"
	"strconv"
	"strings"
)

// 表格(sheet)域的共享类型与纯函数:CSV 适配器与原先的 Excel 适配器共用
// (Excel 能力已整体删除,这批类型/函数只服务 CSV 链路)。
//
// 全部从已删除的 excel.go 原样平移——CSV 与 Excel 曾互相复用的 JSON 线形状
// (`SheetData` / `CellChange` / `FindReplaceOptions`)是前端契约,不能漂移。

// CellChange 单元格修改
type CellChange struct {
	Row   int    `json:"row"`
	Col   int    `json:"col"`
	Value string `json:"value"`
}

// FindReplaceOptions 查找替换选项
type FindReplaceOptions struct {
	Find       string `json:"find"`
	Replace    string `json:"replace"`
	MatchCase  bool   `json:"matchCase,omitempty"`
	EntireCell bool   `json:"entireCell,omitempty"`
	UseRegex   bool   `json:"useRegex,omitempty"`
}

// SheetData 返回的 Sheet 数据
type SheetData struct {
	SheetName string     `json:"sheetName"`
	Columns   []string   `json:"columns"`
	Rows      [][]string `json:"rows"`
	TotalRows int        `json:"totalRows"`
}

// maxColumnCount 行的最大列数(窄表按最宽行补空)。
func maxColumnCount(rows [][]string) int {
	maxCols := 0
	for _, row := range rows {
		if len(row) > maxCols {
			maxCols = len(row)
		}
	}
	return maxCols
}

// cellValueAt 取行内某一列,越界返回空串。
func cellValueAt(row []string, col int) string {
	if col < 0 || col >= len(row) {
		return ""
	}
	return row[col]
}

// isRowEmpty 整行都是空白单元格。
func isRowEmpty(row []string) bool {
	for _, cell := range row {
		if strings.TrimSpace(cell) != "" {
			return false
		}
	}
	return true
}

// trimTrailingEmptyRows 去掉数据区尾部全空的行(避免前端渲染大块留白)。
func trimTrailingEmptyRows(rows [][]string) [][]string {
	end := len(rows)
	for end > 0 && isRowEmpty(rows[end-1]) {
		end--
	}
	return rows[:end]
}

// compareSheetValues 排序比较:两侧都能解析为数字时按数值比,否则忽略大小写按文本比。
func compareSheetValues(left, right string) int {
	leftNum, leftErr := strconv.ParseFloat(strings.TrimSpace(left), 64)
	rightNum, rightErr := strconv.ParseFloat(strings.TrimSpace(right), 64)
	if leftErr == nil && rightErr == nil {
		if leftNum < rightNum {
			return -1
		}
		if leftNum > rightNum {
			return 1
		}
		return 0
	}
	return strings.Compare(strings.ToLower(left), strings.ToLower(right))
}

// buildDedupKey 去重键:columns 为空时按整行,否则只按指定列。
func buildDedupKey(row []string, columns []int, width int) string {
	var b strings.Builder
	if len(columns) == 0 {
		for col := 0; col < width; col++ {
			b.WriteString(cellValueAt(row, col))
			b.WriteByte(0)
		}
		return b.String()
	}
	for _, col := range columns {
		b.WriteString(cellValueAt(row, col))
		b.WriteByte(0)
	}
	return b.String()
}

// replaceCellText 单格查找替换:支持正则 / 整格匹配 / 忽略大小写。
// 返回 (新值, 是否发生替换)。
func replaceCellText(value string, opts FindReplaceOptions, re *regexp.Regexp) (string, bool) {
	if opts.UseRegex && re != nil {
		if opts.EntireCell && !re.MatchString(value) {
			return value, false
		}
		if opts.EntireCell && re.FindString(value) != value {
			return value, false
		}
		next := re.ReplaceAllString(value, opts.Replace)
		return next, next != value
	}

	haystack := value
	needle := opts.Find
	if !opts.MatchCase {
		haystack = strings.ToLower(haystack)
		needle = strings.ToLower(needle)
	}
	if opts.EntireCell {
		if haystack != needle {
			return value, false
		}
		return opts.Replace, true
	}
	if !strings.Contains(haystack, needle) {
		return value, false
	}
	if opts.MatchCase {
		return strings.ReplaceAll(value, opts.Find, opts.Replace), true
	}
	return replaceAllFold(value, opts.Find, opts.Replace), true
}

// replaceAllFold 忽略大小写的全文替换(find 为空时原样返回)。
func replaceAllFold(value, find, replace string) string {
	if find == "" {
		return value
	}
	lowerValue := strings.ToLower(value)
	lowerFind := strings.ToLower(find)
	var b strings.Builder
	start := 0
	for {
		idx := strings.Index(lowerValue[start:], lowerFind)
		if idx < 0 {
			b.WriteString(value[start:])
			break
		}
		idx += start
		b.WriteString(value[start:idx])
		b.WriteString(replace)
		start = idx + len(find)
	}
	return b.String()
}
