/**
 * 文件信息弹窗(2026-08-24):点击目录树中的文件时弹出——展示元信息
 * (路径/大小/修改时间/只读)+ 内容预览,并支持在对话框中直接编辑保存。
 *
 * 编辑门禁(与 Read 卡一致):AI 运行中(会话 running)只读并提示、
 * 隐藏保存按钮;AI 空闲时可编辑——修改后点「保存」覆盖写回文件。
 */
import { useEffect, useState } from 'react'
import { Modal, ReadBlock, type ReadBlockLine } from '@deepseek-ai/dsh-client-ui-primitives'
import { readLocalTextFile, writeLocalTextFile } from '../file-viewer/file-service.ts'
import { statLocalPath, type LocalPathInfo } from './file-tree-service.ts'
import css from './FileInfoDialog.module.css'

/** 引用文本生成:文件 `@文件名 (路径)`;文件夹 `@文件夹名/ (路径)`。 */
export function renderFileReference(name: string, path: string, kind: 'file' | 'directory'): string {
  const label = kind === 'directory' && !name.endsWith('/') ? `${name}/` : name
  return `@${label} (${path})`
}

/** 人类可读的大小(与 sftp/docker 面板同风格,B 单位)。 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 'B'
  for (const next of units) {
    value /= 1024
    unit = next
    if (value < 1024) break
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`
}

/** 人类可读的修改时间;null(不可读)显示「未知」。 */
export function formatModifiedAt(seconds: number | null): string {
  if (seconds === null) return '未知'
  const date = new Date(seconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 小写文件扩展名 → ReadBlock 语法高亮语言 hint(与 read 工具的映射同族)。 */
const LANG_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'ts', tsx: 'tsx', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  json: 'json', jsonc: 'json',
  py: 'py', rb: 'rb', go: 'go', rs: 'rs', java: 'java',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp',
  cs: 'cs', kt: 'kotlin', swift: 'swift', php: 'php',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
  md: 'md', markdown: 'md', mdx: 'mdx',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', xml: 'xml', lua: 'lua',
}

/**
 * 从路径推导语法高亮语言 hint;无扩展名/未知扩展(如 `.gitignore`)返回
 * undefined(ReadBlock 按纯文本渲染)。
 * @param path - 文件绝对路径。
 * @returns 语言 id,或 undefined。
 */
export function langFromPath(path: string): string | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  const ext = base.slice(dot + 1).toLowerCase()
  return Object.hasOwn(LANG_BY_EXTENSION, ext) ? LANG_BY_EXTENSION[ext] : undefined
}

/** 内容预览截断上限(弹窗内只展示开头,避免整文件渲染)。 */
const PREVIEW_LIMIT = 8 * 1024

/** 大对话框内 ReadBlock 的头部/尾部展示行数(比聊天的 8 行更从容)。 */
const DIALOG_READ_MAX_LINES = 32

/** 把预览文本切成 ReadBlock 行(去除末尾多余换行,行号从 1 起)。 */
function toReadLines(content: string): ReadBlockLine[] {
  const text = content.endsWith('\n') ? content.slice(0, -1) : content
  if (text === '') return []
  return text.split('\n').map((line, index) => ({ number: index + 1, text: line }))
}

/**
 * 渲染文件信息弹窗。
 * @param props.path - 目标文件绝对路径;null = 关闭。
 * @param props.onClose - 关闭弹窗。
 * @param props.aiRunning - AI 是否运行中;true 时只读并隐藏保存(与 Read 卡门禁一致)。
 * @param props.onSaved - 保存成功后回调(用于外部刷新等)。
 * @returns Modal;path 为 null 时不渲染。
 */
export function FileInfoDialog({ path, onClose, aiRunning = false, onSaved }: {
  path: string | null
  onClose: () => void
  aiRunning?: boolean
  onSaved?: () => void
}) {
  const [info, setInfo] = useState<LocalPathInfo | null>(null)
  /** 当前编辑/展示内容(加载后为文件内容,可编辑改写)。 */
  const [content, setContent] = useState('')
  /** 原始内容基线(用于判断是否有改动)。 */
  const [original, setOriginal] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (path === null) return
    let cancelled = false
    setInfo(null)
    setContent('')
    setOriginal('')
    setTruncated(false)
    setError(null)
    setNotice(null)
    setSaving(false)
    setLoading(true)
    void Promise.all([
      statLocalPath(path),
      readLocalTextFile(path).catch((err: unknown) => {
        // 二进制/读取失败:内容预览为空,元信息照常展示。
        /* v8 ignore next 2 -- canceled after unmount: the effect's own `if (cancelled) return` may already have run; rethrow into the shared catch which also no-ops while cancelled */
        if (cancelled) throw err
        setError(err instanceof Error ? err.message : String(err))
        return { content: '', truncated: false }
      }),
    ]).then(([stat, read]) => {
      /* v8 ignore next 1 -- canceled after unmount: the last line sets `cancelled = true`; no state write may follow */
      if (cancelled) return
      setInfo(stat)
      // 编辑态需要完整内容(不在此截断),保存时写回已加载部分;
      // 超出读取窗口(256KB)或窗口截断时标 truncated,提示谨慎操作。
      setContent(read.content)
      setOriginal(read.content)
      setTruncated(read.truncated || read.content.length > PREVIEW_LIMIT)
    }).catch(() => {
      // stat 失败时整体置错(路径不可达)。
      /* v8 ignore next 1 -- canceled after unmount: covered behavior is the stat-fail path above; this guard only suppresses a state write after teardown */
      if (!cancelled) setError('无法读取文件信息')
    }).finally(() => {
      /* v8 ignore next 1 -- canceled after unmount: the guard below is the teardown race; the loading=flase write is exercised by every success/failure test */
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [path])

  /** 保存当前编辑内容:覆盖写回文件。AI 运行中/保存中/无改动不执行。 */
  const save = async (): Promise<void> => {
    if (path === null || saving || aiRunning) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await writeLocalTextFile(path, content)
      setOriginal(content)
      setNotice('已保存')
      onSaved?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (path === null) return null
  /* v8 ignore next 1 -- split always yields ≥1 member; at(-1) is never undefined, so the final ?? is unreachable */
  const name = info?.name ?? path.split(/[\\/]/).at(-1) ?? path
  const previewLines = toReadLines(content)
  const dirty = content !== original
  const canSave = dirty && !aiRunning && !saving && !loading && info?.kind === 'file'

  return (
    <Modal
      open
      onClose={onClose}
      title={`文件信息 — ${name}`}
      closeLabel="关闭"
      className={css.dialog ?? ''}
      contentClassName={css.dialogContent ?? ''}
      footer={(
        <>
          {aiRunning && <span className={css.runningHint}>AI 运行中只能查看</span>}
          <span style={{ flex: 1 }} />
          <button type="button" className={css.closeBtn} onClick={onClose}>关闭</button>
          {info?.kind === 'file' && (
            <button
              type="button"
              className={css.referenceBtn}
              disabled={!canSave}
              title={aiRunning ? 'AI 运行中只能查看' : dirty ? undefined : '暂无改动'}
              onClick={() => { void save() }}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          )}
        </>
      )}
    >
      <div className={css.body}>
        {loading && <div className={css.banner}>读取中…</div>}
        {aiRunning && <div className={css.banner} role="status">AI 运行中只能查看,暂不支持修改</div>}
        {error !== null && <div className={css.bannerError} role="alert">{error}</div>}
        {notice !== null && <div className={css.banner}>{notice}</div>}
        {info !== null && (
          <dl className={css.meta}>
            <div className={css.metaRow}><dt>路径</dt><dd className={css.metaPath}>{info.path}</dd></div>
            <div className={css.metaRow}><dt>大小</dt><dd>{formatFileSize(info.size)}</dd></div>
            <div className={css.metaRow}><dt>修改时间</dt><dd>{formatModifiedAt(info.modifiedAt)}</dd></div>
            <div className={css.metaRow}><dt>类型</dt><dd>{info.kind === 'directory' ? '文件夹' : info.kind === 'file' ? '文件' : info.kind}</dd></div>
            {info.readonly && <div className={css.metaRow}><dt>权限</dt><dd>只读</dd></div>}
          </dl>
        )}
        {truncated && content !== '' && (
          <div className={css.truncatedNotice}>仅加载并保存开头 {PREVIEW_LIMIT / 1024}KB(文件较大,请谨慎操作)</div>
        )}
        {info?.kind === 'file' ? (
          <textarea
            className={css.editor}
            value={content}
            readOnly={aiRunning || loading}
            spellCheck={false}
            aria-label="文件内容"
            onChange={(ev) => { setContent(ev.target.value) }}
          />
        ) : content !== '' ? (
          <ReadBlock
            label={info?.path ?? path}
            lines={previewLines}
            totalLines={previewLines.length}
            lang={langFromPath(path)}
            maxLines={DIALOG_READ_MAX_LINES}
          />
        ) : error === null && !loading ? (
          <div className={css.emptyHint}>空文件</div>
        ) : null}
      </div>
    </Modal>
  )
}