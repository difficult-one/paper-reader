import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { deflateSync, crc32 } from 'node:zlib'

function scannedPage() {
  const width = 1200; const height = 1600
  const raw = Buffer.alloc((width * 3 + 1) * height, 255)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1); raw[row] = 0
    for (let x = 80; x < width - 80; x++) {
      const ink = y > 100 && y < 1480 && y % 32 < 10 && x % 23 < 17
      const grey = ink ? 35 + (x + y) % 50 : 240 + (x * 13 + y * 7) % 16
      raw.fill(grey, row + 1 + x * 3, row + 4 + x * 3)
    }
  }
  const chunk = (name, data) => {
    const type = Buffer.from(name); const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const check = Buffer.alloc(4); check.writeUInt32BE(crc32(Buffer.concat([type, data])))
    return Buffer.concat([length, type, data, check])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

export async function makeScrollFixture(kind) {
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.TimesRoman)
  const sizes = kind === 'mixed' ? [[595, 842], [842, 595], [400, 1000]] : [[595, 842]]
  const image = kind === 'scan' ? await pdf.embedPng(scannedPage()) : null
  for (const [index, size] of sizes.entries()) {
    const page = pdf.addPage(size)
    if (kind === 'mixed' && index === 1) page.setRotation(degrees(90))
    if (image) page.drawImage(image, { x: 0, y: 0, width: size[0], height: size[1] })
    else {
      for (let i = 0; i < Math.floor((size[1] - 80) / 18); i++) page.drawText(`Scientific reading fixture ${index + 1}, line ${i + 1}: x = a + b, verify data.`, { x: 30, y: size[1] - 45 - i * 18, size: 10, font })
      if (kind === 'vector') for (let i = 0; i < 1600; i++) page.drawLine({ start: { x: 20 + i % 500, y: 50 + i % 700 }, end: { x: 50 + (i * 31) % 500, y: 40 + (i * 13) % 700 }, thickness: .25 })
    }
  }
  return pdf
}
