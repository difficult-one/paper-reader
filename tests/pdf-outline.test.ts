import { beforeAll, expect, it } from 'vitest'
import { PDFDocument, degrees } from 'pdf-lib'
import { outlinePosition } from '../src/renderer/src/pdf-outline'

beforeAll(async () => {
  const canvas = await import('@napi-rs/canvas')
  Object.assign(globalThis, { DOMMatrix: canvas.DOMMatrix, ImageData: canvas.ImageData, Path2D: canvas.Path2D })
})

it.each([
  { rotation: 0, destination: [0, { name: 'XYZ' }, 150, 620, null], fraction: .225 },
  { rotation: 90, destination: [0, { name: 'XYZ' }, 150, 620, null], fraction: .25 },
  { rotation: 270, destination: [0, { name: 'XYZ' }, 150, 620, null], fraction: .75 },
  { rotation: 90, destination: [0, { name: 'FitR' }, 120, 200, 300, 600], fraction: .2 },
  { rotation: 270, destination: [0, { name: 'FitR' }, 120, 200, 300, 600], fraction: .5 },
  { rotation: 90, destination: [0, { name: 'FitV' }, 150], fraction: .25 },
  { rotation: 270, destination: [0, { name: 'FitV' }, 150], fraction: .75 },
  { rotation: 0, destination: [0, { name: 'FitH' }, 620], fraction: .225 },
  { rotation: 270, destination: [0, { name: 'FitH' }, 620], fraction: 0 },
])('locates chapter coordinates on a $rotation degree page: $destination', async ({ rotation, destination, fraction }) => {
  const fixture = await PDFDocument.create()
  fixture.addPage([600, 800]).setRotation(degrees(rotation))
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loading = getDocument({ data: await fixture.save() })
  const pdf = await loading.promise
  try { expect(await outlinePosition(pdf, destination)).toEqual({ page: 1, fraction }) }
  finally { await loading.destroy() }
})

it('rejects invalid destinations without clamping them to an unrelated page', async () => {
  const fixture = await PDFDocument.create(); fixture.addPage([600, 800])
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loading = getDocument({ data: await fixture.save() }); const pdf = await loading.promise
  try {
    for (const target of [null, 'missing-chapter', [], [-1, { name: 'Fit' }], [1, { name: 'Fit' }], [NaN, { name: 'Fit' }]]) expect(await outlinePosition(pdf, target)).toBeNull()
  } finally { await loading.destroy() }
})
