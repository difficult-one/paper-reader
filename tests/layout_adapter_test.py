import importlib.util
import pathlib
import sys
import types
import unittest
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'resources/runtime/pdf2zh/site-packages'))
from babeldoc.format.pdf.document_il import Box, PdfCharacter, PdfParagraph, PdfStyle, VisualBbox
from babeldoc.format.pdf.document_il.midend.paragraph_finder import ParagraphFinder

if '--upstream' in sys.argv:
    sys.argv.remove('--upstream')
else:
    spec = importlib.util.spec_from_file_location('reader_layout', ROOT / 'resources/reader_layout.py')
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    adapter.install()


class LayoutTests(unittest.TestCase):
    def setUp(self):
        self.finder = ParagraphFinder.__new__(ParagraphFinder)
        self.finder.translation_config = types.SimpleNamespace(split_short_lines=False)

    def paragraph(self, lines, label='text'):
        compositions = []
        for i, text in enumerate(lines):
            chars = [PdfCharacter(char_unicode=c, box=Box(50 + j * 5, 700 - i * 15, 55 + j * 5, 710 - i * 15), visual_bbox=VisualBbox(Box(50 + j * 5, 700 - i * 15, 55 + j * 5, 710 - i * 15)), pdf_style=PdfStyle(font_size=10), xobj_id=7, render_order=i * 100 + j) for j, c in enumerate(text)]
            compositions.append(self.finder.create_line(chars))
        p = PdfParagraph(pdf_paragraph_composition=compositions, layout_label=label, layout_id=3, xobj_id=7, pdf_style=PdfStyle(font_size=10))
        self.finder.update_paragraph_data(p, update_unicode=True)
        return p

    def split(self, lines, label='text'):
        paragraphs = [self.paragraph(lines, label)]
        self.finder.process_independent_paragraphs(paragraphs, 500)
        return paragraphs

    def test_decimal_numbered_references_remain_independent(self):
        paragraphs = self.split(['1. Barrero, F.; Duran, M. Recent advances.', 'IEEE Trans. 2016, 63, 449-458. [CrossRef]', '2. Duran, M.; Barrero, F. Recent advances.', 'IEEE Trans. 2016, 63, 459-468. [CrossRef]', '3. Levi, E. Converter control. [CrossRef]'])
        self.assertEqual(len(paragraphs), 3)
        self.assertTrue(all(p.xobj_id == 7 and p.layout_id == 3 and p.pdf_style.font_size == 10 for p in paragraphs))
        self.assertEqual(sum(len(p.pdf_paragraph_composition) for p in paragraphs), 5)

    def test_reference_continuation_is_preserved(self):
        paragraphs = self.split(['end of previous reference. [CrossRef]', '[19] Jones, M. Current control.', 'IEEE Trans. 2016, 63, 449-458.', '[20] Smith, A. Motor control.'], 'reference')
        self.assertEqual(len(paragraphs), 3)

    def test_unicode_author_names_do_not_disable_reference_splitting(self):
        paragraphs = self.split(['[15] Rafal Jozefowicz. Language modeling.', '[16] Łukasz Kaiser. Active memory.', 'In Advances in Neural Information Processing Systems.', '[17] Łukasz Kaiser. Neural GPUs.', '[18] Émile Author. Translation.'])
        self.assertEqual(len(paragraphs), 4)
        self.assertEqual(sum(len(p.pdf_paragraph_composition) for p in paragraphs), 5)

    def test_hyphenated_names_and_list_words_are_prose(self):
        self.assertEqual(len(self.split(['[15] Author. First paper.', '[16] Jean-Luc Author. Second paper.', '[17] Author. Third paper.'])), 3)
        self.assertEqual(len(self.split(['1. Cross-validation is used.', '2. Cross-validation remains useful.'])), 2)
        self.assertEqual(len(self.split(['1. P-values are reported.', '2. P-values are adjusted.'])), 2)

    def test_decimal_data_and_equations_are_not_lists(self):
        for lines in [['1.25 V was applied.', '2.50 V was measured.'], ['1. x = a + b', '2. y = c + d'], ['1. λ = a + b', '2. μ = c + d'], ['2016. The first experiment.', '2017. The second experiment.']]:
            self.assertEqual(len(self.split(lines)), 1)

    def test_numbered_body_list_keeps_continuation_lines(self):
        self.assertEqual(len(self.split(['1) Measure current.', 'Use the calibrated sensor.', '2) Estimate the rotor flux.'])), 2)

    def test_unicode_equation_variables_and_relations_are_not_numbered_prose(self):
        for lines in [['1. λ₁ = a + b', '2. μ₂ = c + d'], ['1. λ ≤ a', '2. μ ≥ b'], ['1. x_i ≠ a', '2. y_j ≈ b']]:
            self.assertEqual(len(self.split(lines)), 1)

    def test_ordinary_wrapped_body_is_unchanged(self):
        self.assertEqual(len(self.split(['We propose a new controller for the motor.', 'The reference is discussed in Section 2.', 'It improves tracking under these conditions.'])), 1)

    def test_windows_spawn_entry_installs_the_adapter(self):
        code = f"import sys, runpy; sys.path.insert(0, {str(ROOT / 'resources/runtime/pdf2zh/site-packages')!r}); runpy.run_path({str(ROOT / 'resources/reader_engine.py')!r}, run_name='__mp_main__'); from babeldoc.format.pdf.document_il.midend.paragraph_finder import ParagraphFinder; assert getattr(ParagraphFinder.process_independent_paragraphs, '_reader_layout', False)"
        result = subprocess.run([sys.executable, '-c', code], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))


if __name__ == '__main__':
    unittest.main()
