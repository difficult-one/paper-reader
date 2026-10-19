export interface PdfRasterRequest { id: string; page: number; scale: number; width: number; height: number; priority: number; trace?: boolean }
export interface PdfRasterResult { png: Uint8Array; timings?: { queueMs: number; renderMs: number; encodeMs: number; fontMs?: number; firstContinueMs?: number } }
