import pathlib
import json
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'resources/runtime/pdf2zh/site-packages'))
sys.path.insert(0, str(ROOT / 'resources'))
from babeldoc.format.pdf.document_il import Document, Page, PdfParagraph
from reader_replay import ReplayCache


class ReplayTests(unittest.TestCase):
    def document(self, text='Rotor flux', debug_id='random-1'):
        return Document(page=[Page(page_number=0, pdf_paragraph=[PdfParagraph(unicode=text, debug_id=debug_id)])])

    def test_real_il_roundtrip_keeps_source_map_and_replays_after_debug_ids_change(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = ReplayCache(directory, 'scope-a')
            source = self.document()
            key = cache.key(source)
            mapping = cache.source_map(source)
            translated = self.document('转子磁通')
            cache.save(key, mapping, translated)
            fresh = self.document(debug_id='random-2')
            restored = cache.load(fresh)
            self.assertEqual(restored.page[0].pdf_paragraph[0].unicode, '转子磁通')
            self.assertEqual(cache.read_record(key)['sourceMap'][0]['source'], 'Rotor flux')
            self.assertIsNone(cache.load(self.document('Particle flux')))
            self.assertIsNone(ReplayCache(directory, 'scope-b').load(fresh))

    def test_damaged_intermediate_falls_back_without_deleting_old_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = ReplayCache(directory, 'scope')
            key = cache.key(self.document())
            cache.save(key, cache.source_map(self.document()), self.document('转子磁通'))
            path = pathlib.Path(directory) / f'{key}.json'
            path.write_text('{broken', encoding='utf-8')
            self.assertIsNone(cache.load(self.document()))
            self.assertTrue(path.exists())

    def test_replay_links_the_original_quality_report_without_claiming_new_review(self):
        import reader_replay
        with tempfile.TemporaryDirectory() as directory:
            cache = ReplayCache(directory, 'scope')
            trace = pathlib.Path(directory) / 'replay-trace.json'
            prior_report = str(pathlib.Path(directory) / 'prior-quality.json')
            with patch.dict('os.environ', {'PAPER_READER_QUALITY_REPORT_FILE': prior_report, 'PAPER_READER_REPLAY_TRACE_FILE': str(trace)}):
                cache.save(cache.key(self.document()), cache.source_map(self.document()), self.document('转子磁通'))
                config = types.SimpleNamespace(raise_if_cancelled=lambda: None)
                reader_replay.translate_with_cache(types.SimpleNamespace(translation_config=config), self.document(), lambda *_: self.fail('unexpected remote translation'), cache)
            metadata = json.loads(trace.read_text(encoding='utf-8'))
            self.assertEqual(metadata['sourceQualityReport'], prior_report)
            self.assertEqual(metadata['semanticCoverage'], 'prior-report-linked-not-rechecked')

    def test_cancelled_translation_never_commits_replay_and_complete_replay_skips_terms_and_translation(self):
        import reader_replay
        with tempfile.TemporaryDirectory() as directory:
            cache = ReplayCache(directory, 'scope')
            calls = []
            config = types.SimpleNamespace(raise_if_cancelled=lambda: None)
            engine = types.SimpleNamespace(translation_config=config, total_count=1, ok_count=1, fallback_count=0)
            def translate(_self, doc):
                calls.append('translate')
                doc.page[0].pdf_paragraph[0].unicode = '转子磁通'
            reader_replay.translate_with_cache(engine, self.document(), translate, cache)
            reader_replay.translate_with_cache(engine, self.document(), translate, cache)
            self.assertEqual(calls, ['translate'])
            def cancel():
                raise RuntimeError('cancelled')
            config.raise_if_cancelled = cancel
            with self.assertRaisesRegex(RuntimeError, 'cancelled'):
                reader_replay.translate_with_cache(engine, self.document(), translate, cache)

    def test_installed_adapter_skips_both_paid_stages_and_does_not_cache_fallbacks(self):
        import reader_replay
        from babeldoc.format.pdf.document_il.midend.automatic_term_extractor import AutomaticTermExtractor
        from babeldoc.format.pdf.document_il.midend.il_translator_llm_only import ILTranslatorLLMOnly
        calls = []
        config = types.SimpleNamespace(raise_if_cancelled=lambda: None)
        engine = types.SimpleNamespace(translation_config=config, total_count=1, ok_count=1, fallback_count=0)
        def translate(_self, doc):
            calls.append('translate')
            doc.page[0].pdf_paragraph[0].unicode = '转子磁通'
        def extract(_self, doc):
            calls.append('terms')
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {'PAPER_READER_REPLAY_DIR': directory, 'PAPER_READER_REPLAY_SCOPE': 'scope'}), patch.object(AutomaticTermExtractor, 'procress', extract), patch.object(ILTranslatorLLMOnly, 'translate', translate):
            reader_replay.install()
            for _ in range(2):
                doc = self.document()
                AutomaticTermExtractor.procress(engine, doc)
                ILTranslatorLLMOnly.translate(engine, doc)
                self.assertEqual(doc.page[0].pdf_paragraph[0].unicode, '转子磁通')
            self.assertEqual(calls, ['terms', 'translate'])
            engine.ok_count = 0
            engine.fallback_count = 1
            reader_replay.translate_with_cache(engine, self.document('Another source'), translate, ReplayCache(directory, 'scope'))
            self.assertIsNone(ReplayCache(directory, 'scope').load(self.document('Another source')))


if __name__ == '__main__':
    unittest.main()
