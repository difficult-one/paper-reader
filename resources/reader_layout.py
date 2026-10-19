"""Numbered paragraph repair for the bundled BabelDOC 0.6.3; no vendor edits."""
import copy
import re

MARKER = re.compile(r'^\s*(?:\[(\d{1,3})\]|(\d{1,3})[.)])\s*(?=[^\W\d_])')
VARIABLE = r'[^\W\d_](?:[\d₀-₉]+|[_^](?:\{[^{}]+\}|\w+))?'
EQUATION = re.compile(r'[^\W\d_]\w*(?:\s*[_^]\s*(?:\{[^{}]+\}|\w+))?\s*[=<>≤≥≠≈≃∝∈∉≡∼]|' + VARIABLE + r'\s*[+\-−](?=\s|\d|[^\W\d_](?!\w))')


def split_numbered(finder, paragraph):
    markers = []
    for index, composition in enumerate(paragraph.pdf_paragraph_composition):
        line = composition.pdf_line
        if not line or not line.pdf_character:
            continue
        text = ''.join(char.char_unicode or '' for char in line.pdf_character)
        match = MARKER.match(text)
        # An equation beginning "1. x = ..." is not a numbered prose item.
        if match and not EQUATION.match(text[match.end():]):
            markers.append((index, int(match.group(1) or match.group(2)), line.box.x))
    is_reference = 'reference' in (paragraph.layout_label or '').lower()
    if not markers or (not is_reference and len(markers) < 2):
        return [paragraph]
    # Use the document's layout/geometry as evidence, never split on arbitrary
    # inline numbers or on every short visual line.
    if any(b[1] != a[1] + 1 or abs(b[2] - a[2]) > 12 for a, b in zip(markers, markers[1:])):
        return [paragraph]
    boundaries = sorted({0, *(marker[0] for marker in markers), len(paragraph.pdf_paragraph_composition)})
    parts = []
    for start, end in zip(boundaries, boundaries[1:]):
        part = copy.copy(paragraph)
        part.pdf_paragraph_composition = paragraph.pdf_paragraph_composition[start:end]
        from babeldoc.format.pdf.document_il.midend.paragraph_finder import generate_base58_id
        part.debug_id = generate_base58_id()
        finder.update_paragraph_data(part, update_unicode=True)
        parts.append(part)
    return parts


def install():
    from babeldoc.format.pdf.document_il.midend.paragraph_finder import ParagraphFinder
    original = ParagraphFinder.process_independent_paragraphs
    if getattr(original, '_reader_layout', False):
        return

    def process(self, paragraphs, median_width):
        original(self, paragraphs, median_width)
        paragraphs[:] = [part for paragraph in paragraphs for part in split_numbered(self, paragraph)]

    process._reader_layout = True
    ParagraphFinder.process_independent_paragraphs = process
