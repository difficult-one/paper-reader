import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ReaderBridge } from '../shared/types'
const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`reader:${name}`, ...args)
const bridge: ReaderBridge = {
  openPdfRaster: (owner, url) => invoke('open-pdf-raster', owner, url),
  renderPdfRaster: (owner, request) => invoke('render-pdf-raster', owner, request),
  prioritizePdfRaster: (owner, id, priority) => invoke('prioritize-pdf-raster', owner, id, priority),
  cancelPdfRaster: (owner, id) => invoke('cancel-pdf-raster', owner, id),
  closePdfRaster: owner => invoke('close-pdf-raster', owner),
  info: () => invoke('info'), settings: () => invoke('settings'),
  saveSettings: settings => invoke('save-settings', settings), testConnection: settings => invoke('test-connection', settings),
  listModels: settings => invoke('list-models', settings),
  openPdf: path => invoke('open-pdf', path),
  selectPdf: path => invoke('select-pdf', path), importPair: (original, translated) => invoke('import-pair', original, translated),
  importSide: (id, side, path) => invoke('import-side', id, side, path),
  saveReading: (id, state) => invoke('save-reading', id, state), exportTranslation: id => invoke('export', id), showDataFolder: () => invoke('show-data'),
  saveLastDocument: path => invoke('save-last-document', path),
  pathForFile: file => webUtils.getPathForFile(file),
  onBeforeClose(listener) { const handler = () => { void listener().catch(() => {}).finally(() => ipcRenderer.send('reader:ready-to-close')) }; ipcRenderer.on('reader:prepare-close', handler); return () => ipcRenderer.removeListener('reader:prepare-close', handler) },
  annotations: id => invoke('annotations', id),
  addAnnotation: (id, draft) => invoke('add-annotation', id, draft),
  editAnnotation: (id, annotationId, changes) => invoke('edit-annotation', id, annotationId, changes),
  deleteAnnotation: (id, annotationId) => invoke('delete-annotation', id, annotationId),
  startQuestion: request => invoke('start-question', request),
  cancelQuestion: (id, requestId) => invoke('cancel-question', id, requestId),
  questionHistory: id => invoke('question-history', id),
  deleteQuestionHistory: (id, conversationId) => invoke('delete-question-history', id, conversationId),
  questionUsage: () => invoke('question-usage'),
  copyText: text => invoke('copy-text', text),
  onQuestion(listener) { const handler = (_event: Electron.IpcRendererEvent, event: Parameters<typeof listener>[0]) => listener(event); ipcRenderer.on('reader:question', handler); return () => ipcRenderer.removeListener('reader:question', handler) }
}
contextBridge.exposeInMainWorld('reader', bridge)
