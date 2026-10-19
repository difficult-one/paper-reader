import { createCanvas } from '@napi-rs/canvas'
import { writeFile } from 'node:fs/promises'
const canvas = createCanvas(256, 256); const ctx = canvas.getContext('2d')
ctx.fillStyle = '#296a53'; ctx.beginPath(); ctx.roundRect(0, 0, 256, 256, 56); ctx.fill()
ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 9; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
ctx.beginPath(); ctx.moveTo(128, 193); ctx.lineTo(128, 78); ctx.bezierCurveTo(101, 57, 71, 61, 51, 69); ctx.lineTo(51, 179); ctx.bezierCurveTo(77, 168, 105, 173, 128, 193); ctx.bezierCurveTo(151, 173, 179, 168, 205, 179); ctx.lineTo(205, 69); ctx.bezierCurveTo(184, 61, 155, 57, 128, 78); ctx.stroke()
const png = canvas.toBuffer('image/png'); await writeFile('resources/icon.png', png)
const header = Buffer.alloc(22); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18)
await writeFile('resources/icon.ico', Buffer.concat([header, png]))
