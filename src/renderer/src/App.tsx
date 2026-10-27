import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction, type SyntheticEvent } from 'react'
import { ArrowDownToLine, ArrowRight, BookOpen, ChevronLeft, ChevronRight, FilePlus2, FileText, Highlighter, Keyboard, Link2, Link2Off, ListTree, MessageCircleQuestion, NotebookPen, PanelLeft, PanelsLeftRight, Settings2, Upload, X } from 'lucide-react'
import { PdfPane, type LoadedPdf, type PaneHandle, type TextSelection } from './PdfPane'
import { Settings } from './Settings'
import { ImportPair } from './ImportPair'
import { freshReading, restoreReading } from './reading-state'
import { AnnotationPanel, SelectionToolbar } from './Annotations'
import { QuestionPanel, type QuestionSelection } from './QuestionPanel'
import { QuestionUsageSummary } from './QuestionUsageSummary'
import { ShortcutsHelp } from './ShortcutsHelp'
import { DocumentList } from './DocumentList'
import { OutlinePanel } from './OutlinePanel'
import { ComparisonPane, type PaperDrop } from './ComparisonPane'
import { isShortcutEditingTarget, readerShortcut, shortcutHint } from './reader-shortcuts'
import { AnnotationUndoHistory } from './annotation-undo'
import type { AppInfo, DocumentSession, HighlightColor, PaperAnnotation, Position, PublicSettings, QuestionConversation, QuestionEvidence, QuestionTurn, ReadMode, ReadingState } from '../../shared/types'

export function App() {
  const [doc, setDoc] = useState<DocumentSession | null>(null)
  const [documents, setDocuments] = useState<DocumentSession[]>([])
  const documentsRef = useRef(documents)
  const [documentsOpen, setDocumentsOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [leftPdf, setLeftPdf] = useState<LoadedPdf | null>(null)
  const [rightPdf, setRightPdf] = useState<LoadedPdf | null>(null)
  const closeOutline = () => { setOutlineOpen(false); document.querySelector<HTMLButtonElement>('.outline-toggle')?.focus() }
  const documentTasks = useRef(Promise.resolve())
  const pendingDocuments = useRef(0)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [pairPaths, setPairPaths] = useState<string[] | null>(null)
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
  const annotationUndo = useRef(new AnnotationUndoHistory())
  const undoing = useRef(false)
  const activeSide = useRef<'left' | 'right'>('left')
  const left = useRef<PaneHandle>(null); const right = useRef<PaneHandle>(null)
  const workspace = useRef<HTMLDivElement>(null)
  const documentRef = useRef(doc); documentRef.current = doc
  const updateDocuments = useCallback((update: (current: DocumentSession[]) => DocumentSession[]) => {
    documentsRef.current = update(documentsRef.current)
    setDocuments(documentsRef.current)
  }, [])
  const enqueueDocument = useCallback((action: () => Promise<void>) => {
    pendingDocuments.current++; setOpening(true)
    const task = documentTasks.current.then(action).finally(() => {
      pendingDocuments.current--; setOpening(pendingDocuments.current > 0)
    })
    documentTasks.current = task.catch(() => {})
    return task
  }, [])
  const saveCurrentDocument = useCallback(async () => {
    const current = documentRef.current
    if (!current) return
    while (documentRef.current?.id === current.id) {
      await Promise.all([...annotationCalls.current])
      clearTimeout(readingSaveTimer.current)
      const state = readingRef.current
      const result = await window.reader.saveReading(current.id, state)
      if (!result.ok) throw new Error(result.error)
      // Reading and note edits remain available while IPC is saving. Flush any
      // newer state before a switch can cancel its pending autosave timer.
      if (readingRef.current === state && annotationCalls.current.size === 0) {
        updateDocuments(items => items.map(item => item.id === current.id ? { ...item, reading: state } : item))
        return
      }
    }
  }, [updateDocuments])
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
      if (documentRef.current?.id !== id) return
      const state = readingRef.current
      updateDocuments(items => items.map(item => item.id === id ? { ...item, reading: state } : item))
      void window.reader.saveReading(id, state).then(result => { if (!result.ok) setNotice(result.error) })
    }, 300)
  }, [updateDocuments])
  const canLink = Boolean(doc?.translatedUrl && doc.pages === doc.translatedPages)
  const mode = reading.mode ?? (doc?.language === 'zh' ? 'original' : 'parallel')
  const originalNotes = useMemo(() => annotations.filter(annotation => annotation.sourceKey === 'original'), [annotations])
  const translatedNotes = useMemo(() => annotations.filter(annotation => annotation.sourceKey === `translated:${doc?.translationKey}`), [annotations, doc?.translationKey])
  const visibleNotes = useMemo(() => [...originalNotes, ...translatedNotes], [originalNotes, translatedNotes])

  const displayDocument = useCallback((next: DocumentSession, imported = false) => {
    const previous = documentRef.current
    if (previous?.id !== next.id || previous?.translationKey !== next.translationKey) { setQuestionSelection(null); setQuestionsOpen(false); annotationUndo.current = new AnnotationUndoHistory() }
    if (previous?.id !== next.id) { setAnnotations([]); setAnnotationsLoadedId(null) }
    const state = restoreReading(next, previous, readingRef.current, imported)
    const session = { ...next, reading: state }
    updateDocuments(items => items.some(item => item.id === next.id) ? items.map(item => item.id === next.id ? session : item) : [...items, session])
    setReading(state)
    setSelection(null); setSelectedNote(null); window.getSelection()?.removeAllRanges()
    documentRef.current = session; setDoc(session)
    void window.reader.saveLastDocument(next.path).then(result => { if (!result.ok) setNotice(result.error) })
    const notices: string[] = []
    if (next.saveWarning) notices.push(next.saveWarning)
    else if (next.savedTranslationPath) notices.push(`中文译文已自动保存至：${next.savedTranslationPath}`)
    if (next.translatedUrl && next.pages !== next.translatedPages) notices.push('两侧论文页数不同，已关闭联动，可分别阅读。')
    else if (!next.hasText) notices.push('此 PDF 没有可选中的正文，仍可浏览页面；选字询问与批注需要先进行 OCR 文字识别。')
    setNotice(notices.join(' '))
  }, [updateDocuments, setReading])
  const openPdf = useCallback((path?: string) => enqueueDocument(async () => {
    setNotice('')
    try {
      await saveCurrentDocument()
      const result = await window.reader.openPdf(path)
      if (!result.ok) throw new Error(result.error)
      if (result.value) { await saveCurrentDocument(); displayDocument(result.value) }
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }), [displayDocument, saveCurrentDocument, enqueueDocument])
  const importPair = (original: string, translated: string) => enqueueDocument(async () => {
      setNotice(''); await saveCurrentDocument()
      const result = await window.reader.importPair(original, translated)
      if (!result.ok) throw new Error(result.error)
      await saveCurrentDocument()
      displayDocument(result.value, true); setPairPaths(null)
  })
  const dropSide = (side: 'left' | 'right', source: PaperDrop) => {
    if (!documentRef.current) return
    const incoming = 'file' in source ? window.reader.pathForFile(source.file) : source
    if (!incoming) { setNotice('无法读取拖入的文件，请从本机拖入 PDF。'); return }
    void enqueueDocument(async () => {
      setNotice(''); await saveCurrentDocument()
      const current = documentRef.current
      if (!current) throw new Error('请先打开左侧论文，再拖入对照文件。')
      const result = await window.reader.importSide(current.id, side, incoming)
      if (!result.ok) throw new Error(result.error)
      await saveCurrentDocument()
      const next = result.value
      if (side === 'left' && next.translatedUrl && current.id === documentRef.current?.id && current.translationKey === next.translationKey) {
        next.reading = { ...(next.reading ?? freshReading()), right: readingRef.current.right, rightZoom: readingRef.current.rightZoom, linked: readingRef.current.linked, mode: 'parallel', translationKey: next.translationKey }
      }
      displayDocument(next, true)
    }).catch(error => setNotice(error instanceof Error ? error.message : String(error)))
  }
  const switchDocument = (id: string) => {
    if (id === documentRef.current?.id) return
    void enqueueDocument(async () => {
      setNotice(''); await saveCurrentDocument()
      const next = documentsRef.current.find(item => item.id === id)
      if (next) displayDocument(next)
    }).catch(error => setNotice(error instanceof Error ? error.message : String(error)))
  }
  const closeDocument = (id: string) => {
    void enqueueDocument(async () => {
      setNotice('')
      const index = documentsRef.current.findIndex(item => item.id === id)
      if (index < 0) return
      const active = documentRef.current?.id === id
      if (active) await saveCurrentDocument()
      updateDocuments(items => items.filter(item => item.id !== id))
      if (!active) return
      const next = documentsRef.current[Math.min(index, documentsRef.current.length - 1)]
      if (next) displayDocument(next)
      else {
        documentRef.current = null; setDoc(null); setReading(freshReading())
        void window.reader.saveLastDocument(null).then(result => { if (!result.ok) setNotice(result.error) })
        setAnnotations([]); setAnnotationsLoadedId(null); setSelection(null); setSelectedNote(null)
        setNotesOpen(false); setQuestionsOpen(false); setQuestionSelection(null)
        annotationUndo.current = new AnnotationUndoHistory(); window.getSelection()?.removeAllRanges()
      }
    }).catch(error => setNotice(error instanceof Error ? error.message : String(error)))
  }
  useEffect(() => {
    void (async () => {
      const [app, configuration] = await Promise.all([window.reader.info(), window.reader.settings()])
      if (app.ok) { setInfo(app.value); if (app.value.initialPath) void openPdf(app.value.initialPath) }
      if (configuration.ok) setSettings(configuration.value); else setNotice(configuration.error)
    })()
  }, [openPdf, displayDocument])
  useEffect(() => window.reader.onBeforeClose(async () => {
    await saveCurrentDocument()
  }), [saveCurrentDocument])
  useEffect(() => {
    if (!selection) return
    const dismiss = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest?.('.selection-toolbar')) return
      setSelection(null); window.getSelection()?.removeAllRanges()
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [selection])
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
  const positionChanged = useCallback((side: 'left' | 'right', position: Position) => {
    if (documentRef.current?.id !== doc?.id) return
    setSelection(null)
    const current = readingRef.current
    const linked = current.linked && canLink && mode === 'parallel'
    if (linked) (side === 'left' ? right : left).current?.goTo(position)
    readingRef.current = { ...current, [side]: position, ...(linked ? { [side === 'left' ? 'right' : 'left']: position } : {}) }
    scheduleReadingSave()
  }, [canLink, mode, scheduleReadingSave, doc?.id])
  const zoomChanged = useCallback((side: 'left' | 'right', value: number) => { if (documentRef.current?.id !== doc?.id) return; setSelection(null); setReading(previous => previous.linked && canLink && mode === 'parallel' ? { ...previous, zoom: value, rightZoom: value } : { ...previous, [side === 'left' ? 'zoom' : 'rightZoom']: value }) }, [canLink, mode, setReading, doc?.id])
  const leftPositionChanged = useCallback((position: Position) => positionChanged('left', position), [positionChanged])
  const rightPositionChanged = useCallback((position: Position) => positionChanged('right', position), [positionChanged])
  const navigateOutline = (side: 'left' | 'right', position: Position) => {
    activeSide.current = side
    window.getSelection()?.removeAllRanges()
    const pane = side === 'left' ? left : right
    pane.current?.goTo(position)
    positionChanged(side, position)
  }
  const leftZoomChanged = useCallback((value: number) => zoomChanged('left', value), [zoomChanged])
  const rightZoomChanged = useCallback((value: number) => zoomChanged('right', value), [zoomChanged])
  const leftSelection = useCallback((value: TextSelection) => {
    if (doc && documentRef.current?.id === doc.id) setSelection({ ...value, sourceKey: 'original', documentId: doc.id })
  }, [doc?.id])
  const rightSelection = useCallback((value: TextSelection) => {
    if (doc && documentRef.current?.id === doc.id) setSelection({ ...value, sourceKey: 'translated:' + doc.translationKey, documentId: doc.id })
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
    if (!current || current.documentId !== doc?.id || annotationsLoadedId !== doc.id || undoing.current) return
    const history = annotationUndo.current
    setSelection(null); window.getSelection()?.removeAllRanges()
    trackAnnotation((async () => {
      const result = await window.reader.addAnnotation(current.documentId, { sourceKey: current.sourceKey, quote: current.quote, anchors: current.anchors, note: '', color })
      if (!result.ok) { setNotice(result.error); return }
      if (documentRef.current?.id !== current.documentId) return
      history.record('remove', result.value)
      setAnnotations(previous => [...previous, result.value]); setSelectedNote(result.value.id)
      if (withNote) { setQuestionsOpen(false); setNotesOpen(true); setTimeout(() => document.querySelector<HTMLTextAreaElement>('.annotation-card.selected textarea')?.focus(), 60) }
    })().catch(error => setNotice(String(error))))
  }
  const editNote = (annotation: PaperAnnotation, note: string, color: HighlightColor) => {
    if (!doc || undoing.current || (annotation.note === note && annotation.color === color)) return
    const id = doc.id
    const history = annotationUndo.current; const editedAt = Date.now()
    setAnnotations(previous => previous.map(item => item.id === annotation.id ? { ...item, note, color, updatedAt: Date.now() } : item))
    trackAnnotation(window.reader.editAnnotation(id, annotation.id, { note, color }).then(result => {
      if (!result.ok) setNotice(result.error)
      else history.record('edit', annotation, editedAt, annotation.color === color)
    }).catch(error => setNotice(String(error))))
  }
  const removeNote = (annotation: PaperAnnotation) => {
    if (!doc || undoing.current) return
    const id = doc.id
    const history = annotationUndo.current
    trackAnnotation(window.reader.deleteAnnotation(id, annotation.id).then(result => {
      if (!result.ok) setNotice(result.error)
      else if (documentRef.current?.id === id) { history.record('restore', annotation); setAnnotations(previous => previous.filter(item => item.id !== annotation.id)); setSelectedNote(null) }
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
    const references = turn.evidence.filter(e => turn.citationIds.includes(e.id)).map(e => `[${e.id}] ${e.sourceVersion === 'original' ? '左侧论文' : '右侧论文'}第 ${e.page} 页`).join('\n')
    const note = `${turn.question}\n\n${turn.answer}${references ? `\n\n${references}` : ''}`
    if (note.length > 12000) throw new Error('回答过长，无法完整保存为备注；请复制回答保留。')
    const history = annotationUndo.current
    const operation = window.reader.addAnnotation(current.id, { sourceKey: conversation.sourceVersion, quote: conversation.selectionSnapshot.quote, anchors: conversation.selectionSnapshot.anchors, color: 'blue', note }).then(result => {
      if (!result.ok) throw new Error(result.error)
      if (documentRef.current?.id === current.id) { history.record('remove', result.value); setAnnotations(previous => [...previous, result.value]) }
    })
    trackAnnotation(operation); await operation
  }
  const toggleLink = () => {
    if (!canLink) return
    if (!reading.linked) right.current?.goTo(readingRef.current.left)
    setReading(previous => ({ ...previous, linked: !previous.linked, right: !previous.linked ? previous.left : previous.right, rightZoom: !previous.linked ? previous.zoom : previous.rightZoom }))
  }
  const undoAnnotation = () => {
    const current = documentRef.current
    if (!current || undoing.current) return
    const history = annotationUndo.current
    const pending = [...annotationCalls.current]
    undoing.current = true
    trackAnnotation((async () => {
      await Promise.all(pending)
      if (history !== annotationUndo.current) return
      const entry = history.latest
      if (!entry) return
      const annotation = entry.annotation
      const stillCurrent = () => history === annotationUndo.current && documentRef.current?.id === current.id
      if (entry.kind === 'remove') {
        const result = await window.reader.deleteAnnotation(current.id, annotation.id)
        if (!result.ok) throw new Error(result.error)
        if (stillCurrent()) { setAnnotations(previous => previous.filter(item => item.id !== annotation.id)); setSelectedNote(previous => previous === annotation.id ? null : previous) }
      } else if (entry.kind === 'restore') {
        const result = await window.reader.addAnnotation(current.id, { sourceKey: annotation.sourceKey, quote: annotation.quote, anchors: annotation.anchors, note: annotation.note, color: annotation.color })
        if (!result.ok) throw new Error(result.error)
        history.remapId(annotation.id, result.value.id)
        if (stillCurrent()) { setAnnotations(previous => [...previous, result.value]); setSelectedNote(result.value.id) }
      } else {
        const result = await window.reader.editAnnotation(current.id, annotation.id, { note: annotation.note, color: annotation.color })
        if (!result.ok) throw new Error(result.error)
        if (stillCurrent()) setAnnotations(previous => previous.map(item => item.id === annotation.id ? result.value : item))
      }
      history.complete(entry)
    })().catch(error => setNotice(`撤销失败：${error instanceof Error ? error.message : String(error)}`)).finally(() => { undoing.current = false }))
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.keyCode === 229 || event.getModifierState('AltGraph')) return
      const action = readerShortcut(event)
      if (!action || showSettings || pairPaths || opening) return
      if (showShortcuts) {
        if (action === 'help' || action === 'escape') { event.preventDefault(); setShowShortcuts(false) }
        return
      }
      if (action === 'help') { event.preventDefault(); setShowShortcuts(true); return }
      if (action === 'escape') {
        if (selection || !window.getSelection()?.isCollapsed) { event.preventDefault(); setSelection(null); window.getSelection()?.removeAllRanges() }
        else if (notesOpen || questionsOpen) { event.preventDefault(); closeAuxiliary() }
        else if (outlineOpen) { event.preventDefault(); closeOutline() }
        return
      }
      if (action === 'open') { event.preventDefault(); void openPdf(); return }
      if (action === 'import') { event.preventDefault(); setPairPaths(doc ? [doc.path] : []); return }
      if (action === 'settings') { event.preventDefault(); setShowSettings(true); return }
      if (isShortcutEditingTarget(event.target)) return
      if (!doc) return
      const pane = (activeSide.current === 'right' ? right.current : left.current) ?? left.current ?? right.current
      event.preventDefault()
      switch (action) {
        case 'page': pane?.focusPageInput(); break
        case 'previous': pane?.turnPage(-1); break
        case 'next': pane?.turnPage(1); break
        case 'zoomIn': pane?.changeZoom(1); break
        case 'zoomOut': pane?.changeZoom(-1); break
        case 'zoomReset': pane?.changeZoom(0); break
        case 'original': changeMode('original'); break
        case 'parallel': changeMode('parallel'); break
        case 'translated': if (doc.translatedUrl) changeMode('translated'); break
        case 'link': if (mode === 'parallel') toggleLink(); break
        case 'highlight': saveSelection('yellow', false); break
        case 'note': saveSelection('yellow', true); break
        case 'undo': undoAnnotation(); break
        case 'annotations':
          if (notesOpen) closeAuxiliary()
          else { auxiliaryFocus.current = document.querySelector<HTMLElement>(`[data-side="${activeSide.current}"] .pdf-scroll`); setQuestionsOpen(false); setNotesOpen(true) }
          break
        case 'questions':
          if (selection) askSelection()
          else if (questionsOpen) closeAuxiliary()
          else { auxiliaryFocus.current = document.querySelector<HTMLElement>(`[data-side="${activeSide.current}"] .pdf-scroll`); setNotesOpen(false); setQuestionsOpen(true) }
          break
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })
  const exportPdf = async () => {
    if (!doc) return
    const result = await window.reader.exportTranslation(doc.id)
    if (!result.ok) setNotice(result.error)
    else if (result.value) setNotice(`右侧论文已保存至：${result.value}`)
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
  const rememberPane = (event: SyntheticEvent) => {
    const side = (event.target as HTMLElement).closest<HTMLElement>('.pdf-pane')?.dataset.side
    if (side === 'left' || side === 'right') activeSide.current = side
  }
  return <main className="app-shell" onDragOver={event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) setDragOver(true) }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false) }} onDrop={event => {
    event.preventDefault(); setDragOver(false)
    if (showSettings || showShortcuts || pairPaths) return
    const files = event.dataTransfer.files
    if (files.length === 2) {
      if (opening) { setNotice('请等待论文打开完成后，再导入对照论文。'); return }
      const paths = Array.from(files).map(file => window.reader.pathForFile(file))
      if (paths.every(Boolean)) setPairPaths(paths)
      return
    }
    if (files.length !== 1) { setNotice('请拖入一份 PDF，或同时拖入两份 PDF 进行对照。'); return }
    const path = window.reader.pathForFile(files[0]); if (path) void openPdf(path)
  }}>
    <header className="app-header">
      <div className="brand-mark"><BookOpen size={23} strokeWidth={1.7} /></div><div className="brand"><strong>论文对照阅读器</strong><span>PAPER READER</span></div>
      <span className="header-divider" />
      <div className="header-caption">阅读 · 对照 · 批注</div>
      <div className="header-actions"><span className="service-indicator ready"><i />本地阅读 · 批注自动保存</span><button className="icon-button" aria-label="快捷键" title={shortcutHint('help')} onClick={() => setShowShortcuts(true)}><Keyboard size={19} /></button><button className="button secondary settings-button" aria-label="API 设置" title={shortcutHint('settings')} onClick={() => setShowSettings(true)}><Settings2 size={16} />API 设置</button></div>
    </header>

    <nav className="document-bar" aria-label="论文操作">
      <button className={`button secondary documents-toggle ${documentsOpen ? 'active' : ''}`} aria-label={documentsOpen ? '收起论文列表' : '展开论文列表'} aria-expanded={documentsOpen} aria-controls="document-list" onClick={() => { setDocumentsOpen(value => !value); setOutlineOpen(false) }}><PanelLeft size={17} />论文<span className="mini-count">{documents.length}</span>{documentsOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}</button>
      {doc && <button className={`button secondary outline-toggle ${outlineOpen ? 'active' : ''}`} aria-label={outlineOpen ? '收起章节目录' : '展开章节目录'} aria-expanded={outlineOpen} aria-controls="chapter-outline" title="展开或收起章节目录" onClick={() => { setOutlineOpen(value => !value); setDocumentsOpen(false) }}><ListTree size={17} />目录{outlineOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}</button>}
      <button className="button primary" title={shortcutHint('open')} onClick={() => void openPdf()} disabled={opening}><FilePlus2 size={17} />{opening ? '正在打开…' : '打开论文'}<kbd>Ctrl O</kbd></button>
      <button className="button secondary import-button" title={shortcutHint('import')} onClick={() => setPairPaths(doc ? [doc.path] : [])} disabled={opening}><PanelsLeftRight size={16} />导入对照论文</button>
      <div className="document-title">{doc ? <><FileText size={17} /><span title={doc.path}>{doc.name}</span><span className="file-pill">PDF</span></> : <span className="muted">打开一篇论文，开始双语阅读</span>}</div>
      {doc && <><select className="mode-select" aria-label="阅读模式" title="切换阅读模式（Alt+1 左侧 / Alt+2 对照 / Alt+3 右侧）" value={mode} onChange={event => changeMode(event.target.value as ReadMode)}><option value="parallel">双栏对照</option><option value="original">单栏左侧</option><option value="translated" disabled={!doc.translatedUrl}>单栏右侧</option></select>{mode === 'parallel' && <button className={`button quiet link-button ${reading.linked && canLink ? 'linked' : ''}`} onClick={toggleLink} disabled={!canLink} aria-pressed={reading.linked && canLink} title="联动阅读（Alt+L）：按对应页和页内位置同步滚动">{reading.linked && canLink ? <Link2 size={16} /> : <Link2Off size={16} />}联动阅读</button>}<button className={`button secondary ${notesOpen ? 'active' : ''}`} aria-label="我的批注" title={shortcutHint('annotations')} aria-pressed={notesOpen} onClick={event => { auxiliaryFocus.current = event.currentTarget; setQuestionsOpen(false); setNotesOpen(!notesOpen) }}><NotebookPen size={16} />批注{visibleNotes.length > 0 && <span className="mini-count">{visibleNotes.length}</span>}</button><button className={`button secondary ${questionsOpen ? 'active' : ''}`} aria-label="论文问答" aria-pressed={questionsOpen} title={shortcutHint('questions')} onClick={event => { auxiliaryFocus.current = event.currentTarget; setNotesOpen(false); setQuestionsOpen(!questionsOpen) }}><MessageCircleQuestion size={16} />提问</button>{doc.translatedUrl && <button className="button secondary" onClick={() => void exportPdf()}><ArrowDownToLine size={16} />另存右侧</button>}</>}
    </nav>
    {notice && <div className="notice" role="status"><span>{notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={15} /></button></div>}

    <div className={`document-workspace ${documentsOpen ? 'documents-open' : ''} ${outlineOpen ? 'outline-open' : ''} ${notesOpen || questionsOpen ? 'auxiliary-open' : ''}`}>
    <DocumentList documents={documents} activeId={doc?.id} open={documentsOpen} busy={opening} select={switchDocument} remove={closeDocument} add={() => void openPdf()} close={() => { setDocumentsOpen(false); document.querySelector<HTMLButtonElement>('.documents-toggle')?.focus() }} />
    {doc && <OutlinePanel key={doc.id + ':' + (doc.translationKey ?? '')} doc={doc} mode={mode} open={outlineOpen} left={leftPdf} right={rightPdf} navigate={navigateOutline} close={closeOutline} />}
    {!doc ? <div className="welcome">
      <div className="welcome-content"><h1>让阅读，沉淀为<span>理解。</span></h1><p className="welcome-tagline">留给阅读，也留给思考</p><p className="welcome-description">高亮重点，记录想法。<br />把两篇论文放在一起，对照方法、结果与思路。</p>
        <button className="drop-card" onClick={() => void openPdf()} disabled={opening}><span className="upload-symbol"><Upload size={29} strokeWidth={1.5} /></span><strong>{opening ? '正在打开论文…' : '将 PDF 论文拖到这里'}</strong><span className="drop-action">或者点击选择本地文件 <ArrowRight size={14} /></span><small>支持可选中文字的 PDF · 原文件保持完整</small></button>
        <p className="welcome-pair">想同时阅读两篇论文？<button className="text-button" onClick={() => setPairPaths([])}>导入对照论文</button><span>或同时拖入两份 PDF，支持任意语言组合</span></p>
        <div className="welcome-features"><span><BookOpen size={17} />多篇论文切换</span><span><Highlighter size={17} />高亮与文字备注</span><span><PanelsLeftRight size={17} />任意论文双栏对照</span></div>
        <div className="welcome-step"><span>打开论文，即可阅读与批注</span><span>·</span><span>使用询问时配置 API</span></div>
      </div><div className="welcome-footnote">左右两侧可以是不同论文或不同版本，关键结论请结合各自内容核实。</div>
    </div> : <div className="reader-body">
      <div className={`reading-workspace ${mode === 'parallel' ? '' : 'single-mode'}`} ref={workspace} onPointerDownCapture={rememberPane} onFocusCapture={rememberPane} onWheelCapture={rememberPane} style={{ gridTemplateColumns: mode === 'parallel' ? `minmax(0, ${reading.split}fr) 8px minmax(0, ${100 - reading.split}fr)` : 'minmax(0, 1fr)' }}>
        {mode !== 'translated' && <ComparisonPane side="left" enabled={mode === 'parallel' && !showSettings && !showShortcuts && !pairPaths} drop={source => dropSide('left', source)} clearGlobal={() => setDragOver(false)}><PdfPane key={`left-${doc.id}-${doc.originalUrl}`} ref={left} side="left" url={doc.originalUrl} fileName={doc.name} zoom={reading.zoom} initialPosition={reading.left} annotations={originalNotes} onSelection={leftSelection} onAnnotation={annotationClicked} onPosition={leftPositionChanged} onZoom={leftZoomChanged} onLoad={setLeftPdf} /></ComparisonPane>}
        {mode === 'parallel' && <div className="splitter" role="separator" tabIndex={0} aria-label="调整左右阅读栏宽度" aria-valuenow={Math.round(reading.split)} aria-valuemin={25} aria-valuemax={75} aria-orientation="vertical" onPointerDown={resize} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setReading(previous => ({ ...previous, split: Math.max(25, Math.min(75, previous.split + (event.key === 'ArrowLeft' ? -2 : 2))) })) } }}><span /></div>}
        {mode !== 'original' && <ComparisonPane side="right" enabled={mode === 'parallel' && !showSettings && !showShortcuts && !pairPaths} drop={source => dropSide('right', source)} clearGlobal={() => setDragOver(false)}>{doc.translatedUrl ? <PdfPane key={`right-${doc.id}-${doc.translatedUrl}`} ref={right} side="right" url={doc.translatedUrl} fileName={doc.translatedName ?? '右侧论文.pdf'} zoom={reading.rightZoom ?? reading.zoom} initialPosition={reading.right} annotations={translatedNotes} onSelection={rightSelection} onAnnotation={annotationClicked} onPosition={rightPositionChanged} onZoom={rightZoomChanged} onLoad={setRightPdf} /> : <section className="translation-placeholder" data-side="right"><div className="pane-toolbar"><div className="pane-language"><span className="language-tag">右</span><span>右侧论文</span><span className="pane-note">待导入</span></div></div><div className="translation-empty"><div className="translation-symbol"><PanelsLeftRight size={34} strokeWidth={1.4} /></div><h2>拖入另一篇论文，开始对照</h2><p>从桌面、资源管理器或左侧列表拖入 PDF。
支持中文、英文或任意语言组合。</p><button className="button secondary" onClick={() => setPairPaths([doc.path])}><PanelsLeftRight size={16} />选择对照 PDF</button><button className="text-button" onClick={() => changeMode('original')}>专注阅读左侧</button><small>对照阅读无需配置 API</small></div></section>}</ComparisonPane>}
      </div>
      <div className="reader-auxiliary" hidden={!notesOpen && !questionsOpen}>
        <div className="auxiliary-tabs" role="tablist" aria-label="阅读辅助面板" onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = !questionsOpen; setQuestionsOpen(next); setNotesOpen(!next); event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next ? 1 : 0]?.focus() } }}><button role="tab" id="notes-tab" aria-selected={notesOpen} aria-controls="notes-panel" tabIndex={notesOpen ? 0 : -1} onClick={() => { setQuestionsOpen(false); setNotesOpen(true) }}>批注</button><button role="tab" id="questions-tab" aria-selected={questionsOpen} aria-controls="questions-panel" tabIndex={questionsOpen ? 0 : -1} onClick={() => { setNotesOpen(false); setQuestionsOpen(true) }}>论文问答</button></div>
        <div role="tabpanel" id="notes-panel" aria-labelledby="notes-tab" hidden={!notesOpen}><AnnotationPanel annotations={visibleNotes} selectedId={selectedNote} saving={notesSaving > 0} select={selectNote} edit={editNote} remove={removeNote} close={closeAuxiliary} /></div>
        <div role="tabpanel" id="questions-panel" aria-labelledby="questions-tab" hidden={!questionsOpen}><QuestionPanel key={doc.id + ':' + (doc.translationKey ?? '')} doc={doc} settings={settings} visible={questionsOpen} selection={questionSelection} close={closeAuxiliary} configure={() => setShowSettings(true)} cite={citeEvidence} save={saveQuestionNote} /></div>
      </div>
    </div>}
    </div>

    <QuestionUsageSummary />
    <footer className="status-bar"><span><i className="status-dot" />{doc ? `${documents.length} 篇论文 · ${doc.pages} 页 · ${mode === 'parallel' ? '双栏对照' : mode === 'translated' ? '右侧论文阅读' : '左侧论文阅读'}` : '本地论文阅读空间'}</span><span>{notesSaving ? '正在保存批注…' : doc && reading.linked && canLink && mode === 'parallel' ? '按页码与页内位置联动' : '选中文字可询问、高亮与备注'}<span className="status-divider">|</span>阅读记录保存在本机</span></footer>
    {selection && <SelectionToolbar x={selection.x} y={selection.y} save={saveSelection} ask={askSelection} close={() => { setSelection(null); window.getSelection()?.removeAllRanges() }} />}
    {dragOver && <div className="drag-overlay"><Upload size={42} /><strong>松开以添加 PDF 论文</strong><span>连续拖入，追加到论文列表 · 同时拖入两份可导入对照论文</span></div>}
    {pairPaths && <ImportPair paths={pairPaths} close={() => setPairPaths(null)} open={importPair} />}
    {showSettings && <Settings current={settings} info={info} close={() => setShowSettings(false)} saved={configuration => { setSettings(configuration); setShowSettings(false) }} />}
    {showShortcuts && <ShortcutsHelp close={() => setShowShortcuts(false)} />}
  </main>
}
