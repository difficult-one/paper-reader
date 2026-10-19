import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { ArrowDownToLine, ArrowRight, BookOpen, Check, ChevronDown, FilePlus2, FileText, Highlighter, Languages, Link2, Link2Off, LoaderCircle, MessageCircleQuestion, NotebookPen, PanelsLeftRight, Settings2, Sparkles, Upload, X, XCircle } from 'lucide-react'
import { PdfPane, type PaneHandle, type TextSelection } from './PdfPane'
import { Settings } from './Settings'
import { ImportPair } from './ImportPair'
import { freshReading, restoreReading } from './reading-state'
import { AnnotationPanel, SelectionToolbar } from './Annotations'
import { QuestionPanel, type QuestionSelection } from './QuestionPanel'
import { QuestionUsageSummary } from './QuestionUsageSummary'
import { outputTokenSpeed, serverCacheHitRate } from '../../shared/core'
import type { AppInfo, DocumentSession, HighlightColor, PaperAnnotation, Position, PublicSettings, QuestionConversation, QuestionEvidence, QuestionTurn, ReadMode, ReadingState, TranslationJob } from '../../shared/types'

export function App() {
  const [doc, setDoc] = useState<DocumentSession | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [pairPaths, setPairPaths] = useState<string[] | null>(null)
  const [job, setJob] = useState<TranslationJob | null>(null)
  const [reading, setReadingState] = useState<ReadingState>(freshReading)
  const readingRef = useRef(reading)
  const setReading = useCallback((update: SetStateAction<ReadingState>) => {
    const next = typeof update === 'function' ? update(readingRef.current) : update
    readingRef.current = next; setReadingState(next)
  }, [])
  const readingSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [notice, setNotice] = useState('')
  const [opening, setOpening] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [annotations, setAnnotations] = useState<PaperAnnotation[]>([])
  const [annotationsLoadedId, setAnnotationsLoadedId] = useState<string | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const [questionsOpen, setQuestionsOpen] = useState(false)
  const [questionSelection, setQuestionSelection] = useState<QuestionSelection | null>(null)
  const auxiliaryFocus = useRef<HTMLElement | null>(null)
  const [selectedNote, setSelectedNote] = useState<string | null>(null)
  const [notesSaving, setNotesSaving] = useState(0)
  const [selection, setSelection] = useState<(TextSelection & { sourceKey: string; documentId: string }) | null>(null)
  const annotationCalls = useRef(new Set<Promise<unknown>>())
  const left = useRef<PaneHandle>(null); const right = useRef<PaneHandle>(null)
  const workspace = useRef<HTMLDivElement>(null)
  const documentRef = useRef(doc); documentRef.current = doc
  const closeAuxiliary = () => {
    setQuestionsOpen(false); setNotesOpen(false)
    requestAnimationFrame(() => {
      const target = auxiliaryFocus.current?.isConnected ? auxiliaryFocus.current : document.querySelector<HTMLElement>('.pdf-scroll')
      target?.focus({ preventScroll: true })
    })
  }
  const askSelection = () => {
    if (!selection || selection.documentId !== documentRef.current?.id) return
    auxiliaryFocus.current = document.querySelector<HTMLElement>(`[data-side="${selection.sourceKey === 'original' ? 'left' : 'right'}"] .pdf-scroll`)
    setQuestionSelection({ sourceVersion: selection.sourceKey, snapshot: structuredClone({ quote: selection.quote, anchors: selection.anchors }) })
    setSelection(null); window.getSelection()?.removeAllRanges(); setNotesOpen(false); setQuestionsOpen(true)
  }
  const scheduleReadingSave = useCallback(() => {
    clearTimeout(readingSaveTimer.current)
    const id = documentRef.current?.id
    if (!id) return
    readingSaveTimer.current = setTimeout(() => {
      if (documentRef.current?.id === id) void window.reader.saveReading(id, readingRef.current).then(result => { if (!result.ok) setNotice(result.error) })
    }, 300)
  }, [])
  const running = job?.status === 'running'
  const canLink = Boolean(doc?.translatedUrl && doc.pages === doc.translatedPages)
  const mode = reading.mode ?? (doc?.language === 'zh' ? 'original' : 'parallel')
  const originalNotes = useMemo(() => annotations.filter(annotation => annotation.sourceKey === 'original'), [annotations])
  const translatedNotes = useMemo(() => annotations.filter(annotation => annotation.sourceKey === `translated:${doc?.translationKey}`), [annotations, doc?.translationKey])
  const visibleNotes = useMemo(() => [...originalNotes, ...translatedNotes], [originalNotes, translatedNotes])

  const displayDocument = useCallback((next: DocumentSession, imported = false) => {
    const previous = documentRef.current
    if (previous?.id !== next.id || previous?.translationKey !== next.translationKey) { setQuestionSelection(null); setQuestionsOpen(false) }
    if (previous?.id !== next.id) { setAnnotations([]); setAnnotationsLoadedId(null) }
    setReading(restoreReading(next, previous, readingRef.current, imported))
    setSelection(null); setSelectedNote(null); setDoc(next)
    const notices: string[] = []
    if (next.saveWarning) notices.push(next.saveWarning)
    else if (next.savedTranslationPath) notices.push(`中文译文已自动保存至：${next.savedTranslationPath}`)
    if (next.translatedUrl && next.pages !== next.translatedPages) notices.push('原文与中文版本页数不同，已关闭联动，可分别阅读。')
    else if (!next.hasText) notices.push('此 PDF 没有可选中的正文，仍可浏览页面；翻译与选字批注需要先进行 OCR 文字识别。')
    setNotice(notices.join(' '))
  }, [])
  const openPdf = useCallback(async (path?: string) => {
    setOpening(true); setNotice('')
    try {
      if (documentRef.current) await window.reader.saveReading(documentRef.current.id, readingRef.current)
      const result = await window.reader.openPdf(path)
      if (!result.ok) throw new Error(result.error)
      if (result.value) displayDocument(result.value)
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setOpening(false) }
  }, [displayDocument])
  const importPair = async (original: string, translated: string) => {
    setOpening(true); setNotice('')
    try {
      if (documentRef.current) {
        const saved = await window.reader.saveReading(documentRef.current.id, readingRef.current)
        if (!saved.ok) throw new Error(saved.error)
      }
      const result = await window.reader.importPair(original, translated)
      if (!result.ok) throw new Error(result.error)
      displayDocument(result.value, true); setPairPaths(null)
    } finally { setOpening(false) }
  }
  useEffect(() => {
    void (async () => {
      const [app, configuration, current] = await Promise.all([window.reader.info(), window.reader.settings(), window.reader.currentJob()])
      if (app.ok) { setInfo(app.value); if (app.value.initialPath) void openPdf(app.value.initialPath) }
      if (configuration.ok) setSettings(configuration.value); else setNotice(configuration.error)
      if (current.ok) setJob(current.value)
    })()
    return window.reader.onJob(next => {
      setJob(next)
      if (next.result && documentRef.current?.id === next.documentId) {
        displayDocument(next.result)
      }
    })
  }, [openPdf, displayDocument])
  useEffect(() => window.reader.onBeforeClose(async () => {
    await Promise.all([...annotationCalls.current])
    if (documentRef.current) await window.reader.saveReading(documentRef.current.id, readingRef.current)
  }), [])
  useEffect(() => {
    if (!doc) { setAnnotations([]); return }
    const id = doc.id
    void window.reader.annotations(id).then(result => {
      if (documentRef.current?.id !== id) return
      if (result.ok) { setAnnotations(result.value); setAnnotationsLoadedId(id) } else setNotice(result.error)
    })
  }, [doc?.id])
  useEffect(() => {
    scheduleReadingSave()
    return () => clearTimeout(readingSaveTimer.current)
  }, [doc?.id, reading, scheduleReadingSave])
  useEffect(() => { if (!running) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [running])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'o') { event.preventDefault(); if (!showSettings && !pairPaths && !opening) void openPdf() }
      if (event.altKey && event.key.toLowerCase() === 'q' && selection && !showSettings && !pairPaths) { event.preventDefault(); askSelection() }
      if (event.key === 'Escape' && (notesOpen || questionsOpen) && !showSettings && !pairPaths) { event.preventDefault(); closeAuxiliary() }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [openPdf, showSettings, pairPaths, opening, selection, questionsOpen, notesOpen])

  const positionChanged = useCallback((side: 'left' | 'right', position: Position) => {
    setSelection(null)
    const current = readingRef.current
    const linked = current.linked && canLink && mode === 'parallel'
    if (linked) (side === 'left' ? right : left).current?.goTo(position)
    readingRef.current = { ...current, [side]: position, ...(linked ? { [side === 'left' ? 'right' : 'left']: position } : {}) }
    scheduleReadingSave()
  }, [canLink, mode, scheduleReadingSave])
  const zoomChanged = useCallback((side: 'left' | 'right', value: number) => { setSelection(null); setReading(previous => previous.linked && canLink && mode === 'parallel' ? { ...previous, zoom: value, rightZoom: value } : { ...previous, [side === 'left' ? 'zoom' : 'rightZoom']: value }) }, [canLink, mode, setReading])
  const leftPositionChanged = useCallback((position: Position) => positionChanged('left', position), [positionChanged])
  const rightPositionChanged = useCallback((position: Position) => positionChanged('right', position), [positionChanged])
  const leftZoomChanged = useCallback((value: number) => zoomChanged('left', value), [zoomChanged])
  const rightZoomChanged = useCallback((value: number) => zoomChanged('right', value), [zoomChanged])
  const leftSelection = useCallback((value: TextSelection) => {
    if (doc) setSelection({ ...value, sourceKey: 'original', documentId: doc.id })
  }, [doc?.id])
  const rightSelection = useCallback((value: TextSelection) => {
    if (doc) setSelection({ ...value, sourceKey: 'translated:' + doc.translationKey, documentId: doc.id })
  }, [doc?.id, doc?.translationKey])
  const annotationClicked = useCallback((id: string) => { setSelectedNote(id); setQuestionsOpen(false); setNotesOpen(true) }, [])
  const changeMode = (next: ReadMode) => {
    setSelection(null)
    const current = readingRef.current
    const position = mode === 'translated' ? current.right : current.left
    const zoom = mode === 'translated' ? current.rightZoom ?? current.zoom : current.zoom
    setReading(previous => ({ ...previous, mode: next, ...(previous.linked && canLink ? { left: position, right: position, zoom, rightZoom: zoom } : {}) }))
    if (reading.linked && canLink) { left.current?.goTo(position); right.current?.goTo(position) }
  }
  const trackAnnotation = (operation: Promise<unknown>) => {
    annotationCalls.current.add(operation); setNotesSaving(annotationCalls.current.size)
    const complete = () => { annotationCalls.current.delete(operation); setNotesSaving(annotationCalls.current.size) }
    void operation.then(complete, complete)
  }
  const saveSelection = (color: HighlightColor, withNote: boolean) => {
    const current = selection
    if (!current || current.documentId !== doc?.id || annotationsLoadedId !== doc.id) return
    setSelection(null); window.getSelection()?.removeAllRanges()
    trackAnnotation((async () => {
      const result = await window.reader.addAnnotation(current.documentId, { sourceKey: current.sourceKey, quote: current.quote, anchors: current.anchors, note: '', color })
      if (!result.ok) { setNotice(result.error); return }
      if (documentRef.current?.id !== current.documentId) return
      setAnnotations(previous => [...previous, result.value]); setSelectedNote(result.value.id)
      if (withNote) { setQuestionsOpen(false); setNotesOpen(true); setTimeout(() => document.querySelector<HTMLTextAreaElement>('.annotation-card.selected textarea')?.focus(), 60) }
    })().catch(error => setNotice(String(error))))
  }
  const editNote = (annotation: PaperAnnotation, note: string, color: HighlightColor) => {
    if (!doc) return
    const id = doc.id
    setAnnotations(previous => previous.map(item => item.id === annotation.id ? { ...item, note, color, updatedAt: Date.now() } : item))
    trackAnnotation(window.reader.editAnnotation(id, annotation.id, { note, color }).then(result => { if (!result.ok) setNotice(result.error) }).catch(error => setNotice(String(error))))
  }
  const removeNote = (annotation: PaperAnnotation) => {
    if (!doc) return
    const id = doc.id
    trackAnnotation(window.reader.deleteAnnotation(id, annotation.id).then(result => {
      if (!result.ok) setNotice(result.error)
      else if (documentRef.current?.id === id) { setAnnotations(previous => previous.filter(item => item.id !== annotation.id)); setSelectedNote(null) }
    }).catch(error => setNotice(String(error))))
  }
  const selectNote = (annotation: PaperAnnotation) => {
    const side = annotation.sourceKey === 'original' ? 'left' : 'right'
    const anchor = annotation.anchors[0]
    const target = { page: anchor.page, fraction: Math.max(0, anchor.rects[0].y - .08) }
    const nextMode = side === 'left' && mode === 'translated' ? 'original' : side === 'right' && mode === 'original' ? 'translated' : mode
    setSelectedNote(annotation.id); setQuestionsOpen(false); setNotesOpen(true)
    setReading(previous => ({ ...previous, mode: nextMode, [side]: target }))
    ;(side === 'left' ? left : right).current?.goTo(target)
    if (nextMode === 'parallel' && reading.linked && canLink) positionChanged(side, target)
  }
  const citeEvidence = (evidence: QuestionEvidence) => {
    const current = documentRef.current
    if (!current || (evidence.sourceVersion !== 'original' && evidence.sourceVersion !== `translated:${current.translationKey}`)) { setNotice('此出处的论文版本已变化，请重新选字提问。'); return }
    const side = evidence.sourceVersion === 'original' ? 'left' : 'right'
    const target = { page: evidence.page, fraction: Math.max(0, (evidence.rects[0]?.y ?? 0) - .08) }
    const nextMode = side === 'left' && mode === 'translated' ? 'original' : side === 'right' && mode === 'original' ? 'translated' : mode
    setReading(previous => ({ ...previous, mode: nextMode, [side]: target }))
    requestAnimationFrame(() => (side === 'left' ? left : right).current?.goTo(target))
  }
  const saveQuestionNote = async (conversation: QuestionConversation, turn: QuestionTurn) => {
    const current = documentRef.current
    if (!current || current.id !== conversation.documentId || (conversation.sourceVersion !== 'original' && conversation.sourceVersion !== `translated:${current.translationKey}`)) throw new Error('问答对应版本已变化，请重新选字。')
    const references = turn.evidence.filter(e => turn.citationIds.includes(e.id)).map(e => `[${e.id}] ${e.sourceVersion === 'original' ? '原文' : '中文版本'}第 ${e.page} 页`).join('\n')
    const note = `${turn.question}\n\n${turn.answer}${references ? `\n\n${references}` : ''}`
    if (note.length > 12000) throw new Error('回答过长，无法完整保存为备注；请复制回答保留。')
    const operation = window.reader.addAnnotation(current.id, { sourceKey: conversation.sourceVersion, quote: conversation.selectionSnapshot.quote, anchors: conversation.selectionSnapshot.anchors, color: 'blue', note }).then(result => {
      if (!result.ok) throw new Error(result.error)
      if (documentRef.current?.id === current.id) setAnnotations(previous => [...previous, result.value])
    })
    trackAnnotation(operation); await operation
  }
  const toggleLink = () => {
    if (!canLink) return
    if (!reading.linked) right.current?.goTo(readingRef.current.left)
    setReading(previous => ({ ...previous, linked: !previous.linked, right: !previous.linked ? previous.left : previous.right, rightZoom: !previous.linked ? previous.zoom : previous.rightZoom }))
  }
  const translate = async () => {
    if (!doc) return
    if (!settings?.hasApiKey || !settings.model) { setShowSettings(true); return }
    setNotice('')
    const result = await window.reader.startTranslation(doc.id)
    if (result.ok) {
      setJob(result.value)
      if (result.value.result && documentRef.current?.id === doc.id) displayDocument(result.value.result)
    } else setNotice(result.error)
  }
  const exportPdf = async () => {
    if (!doc) return
    const result = await window.reader.exportTranslation(doc.id)
    if (!result.ok) setNotice(result.error)
    else if (result.value) setNotice(`中文译文已保存至：${result.value}`)
  }
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    const divider = event.currentTarget
    const move = (moveEvent: PointerEvent) => {
      const bounds = workspace.current?.getBoundingClientRect(); if (!bounds) return
      setReading(previous => ({ ...previous, split: Math.max(25, Math.min(75, (moveEvent.clientX - bounds.left) / bounds.width * 100)) }))
    }
    const stop = () => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', stop); divider.removeEventListener('pointercancel', stop) }
    divider.addEventListener('pointermove', move); divider.addEventListener('pointerup', stop); divider.addEventListener('pointercancel', stop)
  }
  const elapsed = job ? Math.max(0, Math.floor(((job.finishedAt ?? now) - job.startedAt) / 1000)) : 0
  const elapsedLabel = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
  const jobHere = job?.documentId === doc?.id
  const outputSpeed = job?.usage ? outputTokenSpeed(job.usage) : null
  const cacheHitRate = serverCacheHitRate(job?.usage?.cache)
  return <main className="app-shell" onDragOver={event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) setDragOver(true) }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false) }} onDrop={event => {
    event.preventDefault(); setDragOver(false)
    if (opening || showSettings) return
    const files = event.dataTransfer.files
    if (files.length === 2) {
      const paths = Array.from(files).map(file => window.reader.pathForFile(file))
      if (paths.every(Boolean)) setPairPaths(paths)
      return
    }
    if (pairPaths) return
    if (files.length !== 1) { setNotice('请拖入一份 PDF，或同时拖入中英两份 PDF。'); return }
    const path = window.reader.pathForFile(files[0]); if (path) void openPdf(path)
  }}>
    <header className="app-header">
      <div className="brand-mark"><BookOpen size={23} strokeWidth={1.7} /></div><div className="brand"><strong>论文对照阅读器</strong><span>PAPER READER</span></div>
      <span className="header-divider" />
      <div className="header-caption">阅读 · 对照 · 批注</div>
      <div className="header-actions"><span className="service-indicator ready"><i />本地阅读 · 批注自动保存</span><button className="button secondary settings-button" aria-label="翻译设置" onClick={() => setShowSettings(true)}><Settings2 size={16} />翻译设置</button></div>
    </header>

    <nav className="document-bar" aria-label="论文操作">
      <button className="button primary" onClick={() => void openPdf()} disabled={opening}><FilePlus2 size={17} />{opening ? '正在打开…' : '打开论文'}<kbd>Ctrl O</kbd></button>
      <button className="button secondary import-button" onClick={() => setPairPaths(doc ? [doc.path] : [])} disabled={opening}><PanelsLeftRight size={16} />导入中英对照</button>
      <div className="document-title">{doc ? <><FileText size={17} /><span title={doc.path}>{doc.name}</span><span className="file-pill">PDF</span></> : <span className="muted">打开一篇论文，开始双语阅读</span>}</div>
      {doc && <><select className="mode-select" aria-label="阅读模式" value={mode} onChange={event => changeMode(event.target.value as ReadMode)}><option value="parallel">双栏对照</option><option value="original">单栏原文</option><option value="translated" disabled={!doc.translatedUrl}>单栏中文译文</option></select>{mode === 'parallel' && <button className={`button quiet link-button ${reading.linked && canLink ? 'linked' : ''}`} onClick={toggleLink} disabled={!canLink} aria-pressed={reading.linked && canLink} title="按对应页和页内位置同步滚动">{reading.linked && canLink ? <Link2 size={16} /> : <Link2Off size={16} />}联动阅读</button>}<button className={`button secondary ${notesOpen ? 'active' : ''}`} aria-label="我的批注" aria-pressed={notesOpen} onClick={event => { auxiliaryFocus.current = event.currentTarget; setQuestionsOpen(false); setNotesOpen(!notesOpen) }}><NotebookPen size={16} />批注{visibleNotes.length > 0 && <span className="mini-count">{visibleNotes.length}</span>}</button><button className={`button secondary ${questionsOpen ? 'active' : ''}`} aria-label="论文问答" aria-pressed={questionsOpen} title="选字后按 Alt+Q 提问" onClick={event => { auxiliaryFocus.current = event.currentTarget; setNotesOpen(false); setQuestionsOpen(!questionsOpen) }}><MessageCircleQuestion size={16} />提问</button>{doc.translatedUrl && <button className="button secondary" onClick={() => void exportPdf()}><ArrowDownToLine size={16} />另存译文</button>}</>}
      {doc && doc.language !== 'zh' && <button className="button secondary translate-button" aria-label="翻译全文" disabled={running || !doc.hasText || !info?.runtimeReady} onClick={() => void translate()}>{running ? <LoaderCircle size={17} className="spin" /> : <Languages size={18} />}{running ? '翻译进行中' : '翻译全文'}</button>}
    </nav>
    {notice && <div className="notice" role="status"><span>{notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={15} /></button></div>}
    {info && !info.runtimeReady && <div className="notice warning">翻译引擎资源未找到，请使用附带运行时的完整安装包。原文阅读仍可使用。</div>}

    {!doc ? <div className="welcome">
      <div className="welcome-content"><h1>让阅读，沉淀为<span>理解。</span></h1><p className="welcome-tagline">留给阅读，也留给思考</p><p className="welcome-description">读中文，也读英文。高亮重点，记录想法。<br />需要时，打开中英对照，让思路在两种语言间流动。</p>
        <button className="drop-card" onClick={() => void openPdf()} disabled={opening}><span className="upload-symbol"><Upload size={29} strokeWidth={1.5} /></span><strong>{opening ? '正在打开论文…' : '将 PDF 论文拖到这里'}</strong><span className="drop-action">或者点击选择本地文件 <ArrowRight size={14} /></span><small>支持可选中文字的 PDF · 原文件保持完整</small></button>
        <p className="welcome-pair">已有中英两个版本？<button className="text-button" onClick={() => setPairPaths([])}>导入中英对照</button><span>或同时拖入两份 PDF</span></p>
        <div className="welcome-features"><span><BookOpen size={17} />中英文独立阅读</span><span><Highlighter size={17} />高亮与文字备注</span><span><PanelsLeftRight size={17} />中英双栏对照</span></div>
        <div className="welcome-step"><span>打开论文，即可阅读与批注</span><span>·</span><span>需要翻译时再配置服务</span></div>
      </div><div className="welcome-footnote">中文用于辅助理解，关键术语、实验条件与结论请对照原文核实。</div>
    </div> : <div className="reader-body">
      <div className={`reading-workspace ${mode === 'parallel' ? '' : 'single-mode'}`} ref={workspace} style={{ gridTemplateColumns: mode === 'parallel' ? `minmax(0, ${reading.split}fr) 8px minmax(0, ${100 - reading.split}fr)` : 'minmax(0, 1fr)' }}>
        {mode !== 'translated' && <PdfPane key={`left-${doc.id}`} ref={left} side="left" url={doc.originalUrl} language={doc.language === 'zh' ? '中文' : doc.language === 'en' ? '英文' : '原文'} isTranslation={false} zoom={reading.zoom} initialPosition={reading.left} annotations={originalNotes} onSelection={leftSelection} onAnnotation={annotationClicked} onPosition={leftPositionChanged} onZoom={leftZoomChanged} />}
        {mode === 'parallel' && <div className="splitter" role="separator" tabIndex={0} aria-label="调整中英文阅读栏宽度" aria-valuenow={Math.round(reading.split)} aria-valuemin={25} aria-valuemax={75} aria-orientation="vertical" onPointerDown={resize} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setReading(previous => ({ ...previous, split: Math.max(25, Math.min(75, previous.split + (event.key === 'ArrowLeft' ? -2 : 2))) })) } }}><span /></div>}
        {mode !== 'original' && (doc.translatedUrl ? <PdfPane key={`right-${doc.id}-${doc.translatedUrl}`} ref={right} side="right" url={doc.translatedUrl} zoom={reading.rightZoom ?? reading.zoom} initialPosition={reading.right} annotations={translatedNotes} onSelection={rightSelection} onAnnotation={annotationClicked} onPosition={rightPositionChanged} onZoom={rightZoomChanged} /> : <section className="translation-placeholder" data-side="right"><div className="pane-toolbar"><div className="pane-language"><span className="language-tag">中</span><span>中文译文</span><span className="pane-note">待翻译</span></div></div><div className="translation-empty"><div className={`translation-symbol ${running && jobHere ? 'working' : ''}`}>{running && jobHere ? <LoaderCircle size={34} strokeWidth={1.4} className="spin" /> : <Languages size={34} strokeWidth={1.4} />}</div><h2>{running && jobHere ? '正在为你翻译论文' : '让阅读，跨越语言。'}</h2><p>{running && jobHere ? '你可以继续阅读左侧原文。\n翻译完成后，中文译文会显示在这里。' : '在左侧阅读、选字高亮，记下你的想法。\n需要中文对照时，点击「翻译全文」。'}</p>{!running && <button className="button secondary" onClick={() => changeMode('original')}><BookOpen size={16} />专注阅读原文</button>}<small>{running && jobHere ? '公式与图表保留在原有版式中' : '中文论文可直接单栏阅读，无需翻译服务'}</small></div></section>)}
      </div>
      <div className="reader-auxiliary" hidden={!notesOpen && !questionsOpen}>
        <div className="auxiliary-tabs" role="tablist" aria-label="阅读辅助面板" onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = !questionsOpen; setQuestionsOpen(next); setNotesOpen(!next); event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next ? 1 : 0]?.focus() } }}><button role="tab" id="notes-tab" aria-selected={notesOpen} aria-controls="notes-panel" tabIndex={notesOpen ? 0 : -1} onClick={() => { setQuestionsOpen(false); setNotesOpen(true) }}>批注</button><button role="tab" id="questions-tab" aria-selected={questionsOpen} aria-controls="questions-panel" tabIndex={questionsOpen ? 0 : -1} onClick={() => { setNotesOpen(false); setQuestionsOpen(true) }}>论文问答</button></div>
        <div role="tabpanel" id="notes-panel" aria-labelledby="notes-tab" hidden={!notesOpen}><AnnotationPanel annotations={visibleNotes} selectedId={selectedNote} saving={notesSaving > 0} select={selectNote} edit={editNote} remove={removeNote} close={closeAuxiliary} /></div>
        <div role="tabpanel" id="questions-panel" aria-labelledby="questions-tab" hidden={!questionsOpen}><QuestionPanel key={doc.id + ':' + (doc.translationKey ?? '')} doc={doc} settings={settings} visible={questionsOpen} selection={questionSelection} close={closeAuxiliary} configure={() => setShowSettings(true)} cite={citeEvidence} save={saveQuestionNote} /></div>
      </div>
    </div>}

    {job && <div className={`job-panel ${job.status}`}><div className="job-summary"><span className="job-icon">{running ? <LoaderCircle size={17} className="spin" /> : job.status === 'completed' ? <Check size={17} /> : <XCircle size={17} />}</span><strong>{job.stage}</strong>{job.percent !== null && <span className="job-percent">{Math.round(job.percent)}%</span>}<span className="job-time">{elapsedLabel}</span>{job.error && <span className="job-error" title={job.error}>{job.error}</span>}<div className="job-actions"><button className="text-button" onClick={() => setShowLogs(!showLogs)}>处理记录<ChevronDown size={13} style={{ transform: showLogs ? 'rotate(180deg)' : undefined }} /></button>{running ? <button className="button small secondary" onClick={() => void window.reader.cancelTranslation(job.id)}>取消翻译</button> : job.status === 'failed' && jobHere ? <button className="button small secondary" onClick={() => void translate()}>重试</button> : null}</div></div>{running && <div className={`job-progress ${job.percent === null ? 'indeterminate' : ''}`}><span style={{ width: job.percent === null ? '30%' : `${job.percent}%` }} /></div>}{showLogs && <pre className="job-logs">{job.logs.length ? job.logs.join('\n') : '正在等待翻译引擎的处理记录…'}</pre>}</div>}
    {job?.usage && <div className="job-metrics" aria-label="翻译用量统计">
      <span>API 请求 {job.usage.requests} 次</span><span>本地复用 {job.usage.localCacheHits} 次{Boolean(job.usage.localParagraphHits) && ` · ${job.usage.localParagraphHits} 段`}</span>
      <span title="输出 token 总数除以已完成请求的耗时总和，包含等待及服务商计入的思考用量；并发请求分别计时，本地复用不参与。完整响应返回后更新。">平均输出 {outputSpeed === null ? '待统计' : `${outputSpeed.toFixed(1)} token/s`}</span>
      {job.usage.usageReported ? <>
        <span>输入 {job.usage.cache && !job.usage.cache.fieldSamples.prompt ? '未提供' : `${job.usage.promptTokens.toLocaleString()} token`}</span>
        <span title="仅以同一批有效样本计算 ΣH / (ΣH + ΣM)，本地复用不参与。">缓存命中 {job.usage.cache?.samples ? `${job.usage.cache.hitTokens.toLocaleString()} token${cacheHitRate === null ? '' : ` · ${(cacheHitRate * 100).toFixed(1)}%`}` : '未提供'}</span>
        <span>缓存未命中 {job.usage.cache?.samples ? `${job.usage.cache.missTokens.toLocaleString()} token${job.usage.cache.estimatedSamples ? '（含推算）' : ''}` : '未提供'}</span>
        <span>输出 {job.usage.cache && !job.usage.cache.fieldSamples.completion ? '未提供' : `${job.usage.completionTokens.toLocaleString()} token`}（思考 {job.usage.reasoningUsageReported ? job.usage.reasoningTokens.toLocaleString() : '未提供'}）</span>
        {Boolean(job.usage.qualityRepairRequests) && <span>重点复译 {job.usage.qualityRepairRequests} 次（费用已计入用量）</span>}
      </> : <span>尚无服务商用量数据</span>}
      <span title="缺失或矛盾的缓存 usage 不参与命中率计算，失败请求的未知用量不视作免费。">缓存样本 {job.usage.cache?.samples ?? 0}/{job.usage.requests}{Boolean(job.usage.cache?.anomalousSamples) && ` · 异常 ${job.usage.cache!.anomalousSamples}`}{Boolean(job.usage.cache?.diagnosticWriteFailures) && ` · 日志缺失 ${job.usage.cache!.diagnosticWriteFailures}`}</span>
    </div>}
    <QuestionUsageSummary translation={job?.usage} />
    <footer className="status-bar"><span><i className="status-dot" />{doc ? `${doc.pages} 页 · ${mode === 'parallel' ? '双栏对照' : mode === 'translated' ? '中文译文阅读' : doc.language === 'zh' ? '中文论文阅读' : '原文阅读'}` : '本地论文阅读空间'}</span><span>{notesSaving ? '正在保存批注…' : doc && reading.linked && canLink && mode === 'parallel' ? '按页码与页内位置联动' : '选中文字可询问、高亮与备注'}<span className="status-divider">|</span>阅读记录保存在本机</span></footer>
    {selection && <SelectionToolbar x={selection.x} y={selection.y} save={saveSelection} ask={askSelection} close={() => { setSelection(null); window.getSelection()?.removeAllRanges() }} />}
    {dragOver && <div className="drag-overlay"><Upload size={42} /><strong>松开以打开 PDF 论文</strong><span>一份直接阅读 · 两份中英对照</span></div>}
    {pairPaths && <ImportPair paths={pairPaths} close={() => setPairPaths(null)} open={importPair} />}
    {showSettings && <Settings current={settings} info={info} locked={running} close={() => setShowSettings(false)} saved={configuration => { setSettings(configuration); setShowSettings(false); if (doc) void openPdf(doc.path) }} />}
  </main>
}
