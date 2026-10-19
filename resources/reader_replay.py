"""Replay translation IL before typesetting; source/extraction/policy must all agree."""
import dataclasses
import hashlib
import json
import logging
import os
from pathlib import Path
import uuid

logger = logging.getLogger(__name__)


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class ReplayCache:
    def __init__(self, directory, scope):
        self.directory = Path(directory)
        self.scope = scope

    def key(self, docs):
        from babeldoc.format.pdf.document_il.xml_converter import XMLConverter
        def stable(value):
            if isinstance(value, dict):
                return {k: stable(v) for k, v in value.items() if k != 'debug_id'}
            if isinstance(value, list):
                return [stable(v) for v in value]
            return value
        source = stable(json.loads(XMLConverter().to_json(docs)))
        return digest([self.scope, source])

    @staticmethod
    def source_map(docs):
        return [{'page': page.page_number, 'index': index, 'id': p.debug_id, 'source': p.unicode}
                for page in docs.page for index, p in enumerate(page.pdf_paragraph)]

    def read_record(self, key):
        return json.loads((self.directory / f'{key}.json').read_text(encoding='utf-8'))

    def load(self, docs):
        try:
            from babeldoc.format.pdf.document_il.xml_converter import XMLConverter
            key = self.key(docs)
            data = self.read_record(key)
            if data['version'] != 1 or data['scope'] != self.scope or data['key'] != key:
                return None
            if data['checksum'] != digest([data['sourceMap'], data['translatedXml']]):
                return None
            restored = XMLConverter().from_xml(data['translatedXml'])
            if len(restored.page) != len(docs.page):
                return None
            return restored
        except Exception:
            return None

    def save(self, key, mapping, docs):
        from babeldoc.format.pdf.document_il.xml_converter import XMLConverter
        xml = XMLConverter().to_xml(docs)
        data = {'version': 1, 'scope': self.scope, 'key': key, 'sourceMap': mapping,
                'sourceQualityReport': os.environ.get('PAPER_READER_QUALITY_REPORT_FILE'),
                'translatedXml': xml, 'checksum': digest([mapping, xml])}
        self.directory.mkdir(parents=True, exist_ok=True)
        temporary = self.directory / f'{key}.{uuid.uuid4().hex}.tmp'
        try:
            temporary.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
            temporary.replace(self.directory / f'{key}.json')
        finally:
            temporary.unlink(missing_ok=True)

    def trace_replay(self, docs):
        trace_file = os.environ.get('PAPER_READER_REPLAY_TRACE_FILE')
        if not trace_file:
            return
        key = self.key(docs)
        data = self.read_record(key)
        trace = {'version': 1, 'scope': self.scope, 'key': key,
                 'sourceArtifact': str(self.directory / f'{key}.json'),
                 'sourceQualityReport': data.get('sourceQualityReport'),
                 'semanticCoverage': 'prior-report-linked-not-rechecked'}
        Path(trace_file).write_text(json.dumps(trace, ensure_ascii=False), encoding='utf-8')


def translate_with_cache(engine, docs, original, cache):
    config = engine.translation_config
    config.raise_if_cancelled()
    restored = cache.load(docs)
    if restored is not None:
        config.raise_if_cancelled()
        try:
            cache.trace_replay(docs)
        except Exception:
            logger.warning('Paper Reader: replay provenance trace unavailable; quality coverage remains unobserved.')
        for field in dataclasses.fields(docs):
            setattr(docs, field.name, getattr(restored, field.name))
        logger.info('Paper Reader: replayed structured translation; continuing typesetting.')
        return
    try:
        key, mapping = cache.key(docs), cache.source_map(docs)
    except Exception:
        original(engine, docs)
        return
    original(engine, docs)
    config.raise_if_cancelled()
    # Do not freeze incomplete translations or fallback failures into a whole-document hit.
    if engine.total_count > 0 and engine.ok_count == engine.total_count and engine.fallback_count == 0:
        try:
            cache.save(key, mapping, docs)
        except Exception:
            logger.warning('Paper Reader: intermediate unavailable; paragraph caches remain usable.')


def install():
    directory = os.environ.get('PAPER_READER_REPLAY_DIR')
    scope = os.environ.get('PAPER_READER_REPLAY_SCOPE')
    if not directory or not scope:
        return
    from babeldoc.format.pdf.document_il.midend.automatic_term_extractor import AutomaticTermExtractor
    from babeldoc.format.pdf.document_il.midend.il_translator_llm_only import ILTranslatorLLMOnly
    if getattr(ILTranslatorLLMOnly.translate, '_reader_replay', False):
        return
    cache = ReplayCache(directory, scope)
    extract = AutomaticTermExtractor.procress
    translate = ILTranslatorLLMOnly.translate

    def extract_or_replay(self, docs):
        self.translation_config.raise_if_cancelled()
        # Extraction does not mutate source IL. A complete hit skips both paid stages.
        if cache.load(docs) is None:
            extract(self, docs)

    def replay(self, docs):
        return translate_with_cache(self, docs, translate, cache)

    replay._reader_replay = True
    AutomaticTermExtractor.procress = extract_or_replay
    ILTranslatorLLMOnly.translate = replay
