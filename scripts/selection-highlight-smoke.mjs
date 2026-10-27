import { _electron as electron } from 'playwright'
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve('output/playwright/selection-highlight')
await mkdir(root, { recursive: true })
const pdf = await PDFDocument.create()
const regular = await pdf.embedFont(StandardFonts.TimesRoman)
const bold = await pdf.embedFont(StandardFonts.TimesRomanBold)
for (const rotation of [0, 90, 180, 270]) {
  const sheet = pdf.addPage([600, 800]); sheet.setRotation(degrees(rotation))
  for (const y of [740, 715]) {
    for (const column of [45, 330]) {
      let x = column
      for (const [index, text] of ['Select', 'these', 'words', 'smoothly.'].entries()) {
        const font = index % 2 ? bold : regular
        sheet.drawText(text, { x, y, size: 12, font })
        x += font.widthOfTextAtSize(text, 12) + 4
      }
    }
  }
}
const fixture = join(root, 'fragmented.pdf')
await writeFile(fixture, await pdf.save())
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.', fixture, `--data-dir=${join(root, `data-${Date.now()}`)}`], env })
let page
try {
  page = await app.firstWindow()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.locator('.textLayer span').first().waitFor({ timeout: 30000 })
  await page.getByLabel('阅读模式').selectOption('original')
  await page.getByLabel('左侧缩放').selectOption('1')
  for (const number of [1, 2, 3, 4]) {
    await page.getByLabel('左侧页码', { exact: true }).fill(String(number))
    await page.getByLabel('左侧页码', { exact: true }).press('Enter')
    const slot = page.locator(`[data-side="left"] [data-page="${number}"]`)
    await slot.locator('.textLayer span').first().waitFor()
    const fragments = await slot.locator('.textLayer').evaluate(layer => {
      const spans = [...layer.querySelectorAll('span')].filter(span => span.textContent.trim())
      const range = document.createRange()
      range.setStart(spans[0].firstChild, 0)
      range.setEnd(spans[spans.length - 1].firstChild, spans[spans.length - 1].firstChild.length)
      getSelection().removeAllRanges(); getSelection().addRange(range)
      return spans.length
    })
    assert(fragments >= 16, `fixture must contain fragmented text: ${fragments}`)
    await page.waitForTimeout(100)
    const marks = slot.locator('.text-selection-layer > span')
    assert.equal(await marks.count(), 4, `page ${number}: each of the two lines in each column must have one continuous selection`)
    if (number === 1) {
      await page.screenshot({ path: join(root, 'selected.png') })
      await slot.locator('.textLayer').dispatchEvent('mouseup')
      await page.getByRole('button', { name: '黄色高亮', exact: true }).click()
      await slot.locator('.highlight-mark').first().waitFor()
      assert.equal(await slot.locator('.highlight-mark').count(), 4, 'saved highlights must remain continuous')
      assert.equal(await marks.count(), 0, 'clearing selection must remove temporary highlights')
      await page.screenshot({ path: join(root, 'saved.png') })
      const endpoints = await slot.locator('.textLayer').evaluate(layer => {
        const spans = [...layer.querySelectorAll('span')].filter(span => span.textContent.trim())
        return [spans[0], spans[2]].map(span => span.getBoundingClientRect().toJSON())
      })
      const [start, end] = endpoints
      for (const reverse of [false, true]) {
        const from = reverse ? end : start; const to = reverse ? start : end
        await page.mouse.move(from.x + (reverse ? from.width - 4 : 3), from.y + from.height / 2)
        await page.mouse.down()
        await page.mouse.move(to.x + (reverse ? 3 : to.width - 4), to.y + to.height / 2, { steps: 15 })
        await page.mouse.up()
        await page.waitForTimeout(100)
        assert.equal(await marks.count(), 1, 'forward and backward mouse drags must each create one continuous partial-line highlight')
        const quote = await page.evaluate(() => getSelection().toString())
        assert(quote.length > 8)
        await page.keyboard.press('Control+c')
        assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), quote, 'copy must retain the browser-selected text')
        await page.getByRole('button', { name: '取消选中', exact: true }).click()
      }
      // Retained PDF text nodes and normalized overlays must scale together.
      await slot.locator('.textLayer').evaluate(layer => {
        const node = layer.querySelector('span').firstChild
        getSelection().setBaseAndExtent(node, 1, node, node.length - 1)
      })
      const quote = await page.evaluate(() => getSelection().toString())
      for (const zoom of ['1.5', '0.65', '1']) {
        await page.getByLabel('左侧缩放').selectOption(zoom)
        await page.waitForTimeout(400)
        assert.equal(await page.evaluate(() => getSelection().toString()), quote)
        const geometry = await slot.evaluate(slot => ({
          selected: getSelection().getRangeAt(0).getBoundingClientRect().toJSON(),
          painted: slot.querySelector('.text-selection-layer > span').getBoundingClientRect().toJSON(),
        }))
        for (const edge of ['left', 'top', 'right', 'bottom']) assert(Math.abs(geometry.selected[edge] - geometry.painted[edge]) < 2, `zoom ${zoom}: selection overlay must align at ${edge}`)
      }
      await page.evaluate(() => getSelection().removeAllRanges())
    }
    await page.evaluate(() => getSelection().removeAllRanges())
  }
  assert.deepEqual(errors, [])
  await writeFile(join(root, 'result.json'), JSON.stringify({ passed: true, rotations: [0, 90, 180, 270], errors }, null, 2))
  console.log(`Selection highlight checks passed: ${root}`)
} catch (error) {
  await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  throw error
} finally { await app.close() }
