import { expect, it } from 'vitest'
import { normalizeSelectionRects } from '../src/shared/selection'

const page = { left: 0, top: 0, width: 600, height: 800 }
it('keeps tightly spaced baselines and large initials from connecting separate lines', () => {
  expect(normalizeSelectionRects(page, [
    { left: 10, top: 20, width: 10, height: 36 },
    { left: 24, top: 20, width: 60, height: 12 },
    { left: 24, top: 38, width: 60, height: 12 },
  ])).toHaveLength(3)
  expect(normalizeSelectionRects(page, [
    { left: 10, top: 20, width: 60, height: 16 },
    { left: 10, top: 28, width: 60, height: 16 },
  ])).toHaveLength(2)
})

it('joins adjacent word and font fragments without filling line or column gaps', () => {
  const rects = normalizeSelectionRects(page, [
    { left: 10, top: 20, width: 40, height: 12 },
    { left: 54, top: 19, width: 30, height: 14 },
    { left: 88, top: 20, width: 20, height: 12 },
    { left: 10, top: 40, width: 40, height: 12 },
    { left: 300, top: 20, width: 40, height: 12 },
  ])
  expect(rects).toEqual([
    { x: 10 / 600, y: 19 / 800, width: 98 / 600, height: 14 / 800 },
    { x: 10 / 600, y: 40 / 800, width: 40 / 600, height: 12 / 800 },
    { x: 300 / 600, y: 20 / 800, width: 40 / 600, height: 12 / 800 },
  ])
})

it('merges rotated text along its reading direction', () => {
  for (const rotation of [90, 270]) {
    expect(normalizeSelectionRects(page, [
      { left: 20, top: 10, width: 12, height: 40 },
      { left: 20, top: 54, width: 12, height: 30 },
      { left: 40, top: 10, width: 12, height: 40 },
    ], rotation)).toEqual([
      { x: 20 / 600, y: 10 / 800, width: 12 / 600, height: 74 / 800 },
      { x: 40 / 600, y: 10 / 800, width: 12 / 600, height: 40 / 800 },
    ])
  }
})
