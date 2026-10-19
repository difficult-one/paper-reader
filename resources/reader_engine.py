"""Run the bundled engine with Paper Reader's local layout adapter."""
import asyncio
import multiprocessing
import os
from pathlib import Path
import sys


def install_layout():
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import reader_layout
    reader_layout.install()
    import reader_replay
    reader_replay.install()


def main():
    runtime_root = Path(sys.argv.pop(1)).resolve()
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.path.insert(0, str(runtime_root / 'site-packages'))
    os.environ['PYTHONUTF8'] = '1'
    multiprocessing.set_executable(str(runtime_root / 'runtime/pythonw.exe'))
    install_layout()
    import babeldoc.assets.assets
    babeldoc.assets.assets.restore_offline_assets_package(runtime_root)
    import pdf2zh_next.main
    return asyncio.run(pdf2zh_next.main.main())


if __name__ == '__main__':
    sys.exit(main())
elif __name__ == '__mp_main__':
    # Windows spawn imports this entry afresh; parent monkeypatches are not inherited.
    install_layout()
