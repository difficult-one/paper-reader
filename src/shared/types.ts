export interface ServiceSettings { baseUrl: string; model: string; apiKey: string; qps: number; reasoningEffort?: 'low' | 'high' | 'max'; translationMode?: 'economy' | 'manual' }
export type ProviderSettings = Pick<ServiceSettings, 'baseUrl' | 'apiKey'>
export interface AvailableModel { id: string; name?: string }
export interface PublicSettings extends Omit<ServiceSettings, 'apiKey'> { hasApiKey: boolean }
export interface Position { page: number; fraction: number }
export type ReadMode = 'parallel' | 'original' | 'translated'
export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink'
export interface HighlightRect { x: number; y: number; width: number; height: number }
export interface AnnotationAnchor { page: number; rects: HighlightRect[] }
export interface AnnotationDraft { sourceKey: string; quote: string; note: string; color: HighlightColor; anchors: AnnotationAnchor[] }
export interface PaperAnnotation extends AnnotationDraft { id: string; createdAt: number; updatedAt: number }
export interface SelectionSnapshot { quote: string; anchors: AnnotationAnchor[] }
export interface DocumentParagraph { documentHash: string; sourceVersion: string; page: number; paragraphId: string; text: string; rects: HighlightRect[]; section?: string }
export interface QuestionEvidence extends DocumentParagraph { id: string }
export interface QuestionUsage {
  requests: number; localCacheHits: number; promptTokens: number; completionTokens: number; reasoningTokens: number; cachedPromptTokens: number;
  usageReported: boolean; unknownRequests: number;
}
export type QuestionStatus = 'indexing' | 'sending' | 'completed' | 'failed' | 'cancelled'
export interface QuestionTurn {
  requestId: string; question: string; answer: string; status: QuestionStatus; evidence: QuestionEvidence[]; citationIds: string[];
  warning?: string; error?: string; usage: QuestionUsage; createdAt: number; finishedAt?: number; firstTokenMs?: number;
}
export interface QuestionConversation {
  id: string; documentId: string; documentHash: string; sourceVersion: string; selectionSnapshot: SelectionSnapshot;
  turns: QuestionTurn[]; createdAt: number; updatedAt: number;
}
export interface QuestionRequest {
  requestId: string; documentId: string; sourceVersion: string; selectionSnapshot: SelectionSnapshot;
  question: string; conversationId?: string; disclosureAccepted: boolean;
}
export interface QuestionEvent {
  type: 'started' | 'delta' | 'completed' | 'failed' | 'cancelled'; requestId: string; documentId: string; conversationId: string; sourceVersion: string; sequence: number;
  phase?: 'indexing' | 'sending'; delta?: string; conversation?: QuestionConversation;
}
export interface ReadingState { left: Position; right: Position; zoom: number; rightZoom?: number; split: number; linked: boolean; mode?: ReadMode; translationKey?: string }
export interface PdfInfo { pages: number; hasText: boolean; language: 'en' | 'zh' | 'unknown' }
export interface PdfChoice extends PdfInfo { path: string; name: string }
export interface DocumentSession {
  id: string; name: string; path: string; pages: number; hasText: boolean; language: PdfInfo['language'];
  originalUrl: string; translatedUrl?: string; translatedPages?: number; translationKey?: string; reading?: ReadingState;
  translationSource?: 'imported' | 'generated'; translatedName?: string; translatedPath?: string;
  savedTranslationPath?: string; saveWarning?: string;
}
export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export interface CacheUsageSummary {
  samples: number; estimatedSamples: number; missingSamples: number; anomalousSamples: number;
  hitTokens: number; missTokens: number; rawMissTokens: number; diagnosticWriteFailures: number;
  fieldSamples: { prompt: number; hit: number; miss: number; completion: number; reasoning: number };
}
export interface TranslationUsage {
  requests: number; localCacheHits: number; promptTokens: number; cachedPromptTokens: number;
  completionTokens: number; reasoningTokens: number; usageReported: boolean; cacheUsageReported: boolean; reasoningUsageReported: boolean;
  completionElapsedMs?: number;
  cache?: CacheUsageSummary;
  localParagraphHits?: number;
  inflightWaits?: number;
  qualityRepairRequests?: number;
  semanticReviewRequests?: number;
  localTermSectionHits?: number;
  paragraphs?: { total: number; reused: number };
}
export interface TranslationJob {
  id: string; documentId: string; status: JobStatus; stage: string; percent: number | null;
  startedAt: number; finishedAt?: number; logs: string[]; error?: string; result?: DocumentSession;
  usage?: TranslationUsage;
}
export interface AppInfo { version: string; engineVersion: string; runtimeReady: boolean; dataPath: string; initialPath?: string }
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }
export interface ReaderBridge {
  openPdfRaster(owner: string, url: string): Promise<Result<void>>;
  renderPdfRaster(owner: string, request: import('./pdf-raster').PdfRasterRequest): Promise<Result<import('./pdf-raster').PdfRasterResult>>;
  prioritizePdfRaster(owner: string, id: string, priority: number): Promise<Result<void>>;
  cancelPdfRaster(owner: string, id: string): Promise<Result<void>>;
  closePdfRaster(owner: string): Promise<Result<void>>;
  info(): Promise<Result<AppInfo>>;
  settings(): Promise<Result<PublicSettings>>;
  saveSettings(settings: ServiceSettings): Promise<Result<PublicSettings>>;
  testConnection(settings: ServiceSettings): Promise<Result<string>>;
  listModels(settings: ProviderSettings): Promise<Result<AvailableModel[]>>;
  openPdf(path?: string): Promise<Result<DocumentSession | null>>;
  selectPdf(path?: string): Promise<Result<PdfChoice | null>>;
  importPair(originalPath: string, translatedPath: string): Promise<Result<DocumentSession>>;
  startTranslation(documentId: string): Promise<Result<TranslationJob>>;
  cancelTranslation(jobId: string): Promise<Result<void>>;
  currentJob(): Promise<Result<TranslationJob | null>>;
  saveReading(documentId: string, state: ReadingState): Promise<Result<void>>;
  exportTranslation(documentId: string): Promise<Result<string | null>>;
  showDataFolder(): Promise<Result<void>>;
  pathForFile(file: File): string;
  onJob(listener: (job: TranslationJob) => void): () => void;
  onBeforeClose(listener: () => Promise<void>): () => void;
  annotations(documentId: string): Promise<Result<PaperAnnotation[]>>;
  addAnnotation(documentId: string, draft: AnnotationDraft): Promise<Result<PaperAnnotation>>;
  editAnnotation(documentId: string, annotationId: string, changes: { note: string; color: HighlightColor }): Promise<Result<PaperAnnotation>>;
  deleteAnnotation(documentId: string, annotationId: string): Promise<Result<void>>;
  startQuestion(request: QuestionRequest): Promise<Result<QuestionConversation>>;
  cancelQuestion(documentId: string, requestId: string): Promise<Result<void>>;
  questionHistory(documentId: string): Promise<Result<QuestionConversation[]>>;
  deleteQuestionHistory(documentId: string, conversationId?: string): Promise<Result<void>>;
  questionUsage(): Promise<Result<QuestionUsage>>;
  copyText(text: string): Promise<Result<void>>;
  onQuestion(listener: (event: QuestionEvent) => void): () => void;
}
