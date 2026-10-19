import { parentPort, workerData } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { extractPdfParagraphs, retrieveEvidence, type QuestionDocumentSource } from './document-context'
const source = workerData as QuestionDocumentSource
try {
  if (workerData.operation === 'retrieve') {
    parentPort?.postMessage({ evidence: retrieveEvidence(workerData.paragraphs, workerData.selection, workerData.question) })
  } else {
  const paragraphs = await extractPdfParagraphs(new Uint8Array(await readFile(source.path)), source.documentHash, source.sourceVersion)
  parentPort?.postMessage({ paragraphs })
  }
} catch (error) { parentPort?.postMessage({ error: workerData.operation === 'retrieve' && error instanceof Error ? error.message : '无法提取论文文本，请检查 PDF 或先进行 OCR 文字识别。' }) }
