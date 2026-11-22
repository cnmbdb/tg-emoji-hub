"""crawler 主入口。

CLI:
  python crawler.py full              # 全量爬 Featured + DB.manual 包
  python crawler.py full --dry-run    # 用 FakeClient 跑完整 pipeline 不联网（用 sqlite in-memory）
  python crawler.py watch             # 后台监听 signals/ 目录
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# 让 `python crawler.py` 也能 import lib
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import client as client_mod  # noqa: E402
from lib import db as db_mod  # noqa: E402
from lib import mocks, pipeline, signals  # noqa: E402
from lib.config import Config, configure_logging, load_config  # noqa: E402

log = logging.getLogger("crawler")


async def cmd_full(cfg: Config, *, dry_run: bool,
                   no_thumbs: bool = False, no_originals: bool = False) -> int:
    do_originals = (not no_originals) and cfg.download_originals
    if dry_run:
        log.warning("dry-run 模式：FakeClient + sqlite in-memory，不联网不入生产库")
        engine = db_mod.make_engine("sqlite:///:memory:")
        db_mod.create_all(engine)
        session_factory = db_mod.make_session_factory(engine)
        fake = mocks.FakeClient(num_featured=2)
        stats = await pipeline.run_full_crawl(
            fake, session_factory, cfg.thumbnail_dir,
            download_thumbs=not no_thumbs,
            download_originals=do_originals,
            media_dir=cfg.media_dir,
            r2_base_url=cfg.r2_base_url,
        )
        log.info("dry-run 统计 %s", stats)
        log.info("FakeClient 调用记录 %s", fake.calls)
        log.info("FakeClient 下载记录 %d 个文件 (含缩略图与原文件)", len(fake.downloaded))
        return 0

    engine = db_mod.make_engine(cfg.db_dsn)
    session_factory = db_mod.make_session_factory(engine)
    client = None
    try:
        client = await client_mod.get_client(cfg)
        stats = await pipeline.run_full_crawl(
            client, session_factory, cfg.thumbnail_dir,
            download_thumbs=not no_thumbs,
            download_originals=do_originals,
            media_dir=cfg.media_dir,
            r2_base_url=cfg.r2_base_url,
        )
        log.info("全量爬取统计 %s", stats)
        return 0
    finally:
        await client_mod.disconnect_safely(client)


async def cmd_watch(cfg: Config, *, dry_run: bool, no_originals: bool = False) -> int:
    do_originals = (not no_originals) and cfg.download_originals
    if dry_run:
        log.warning("dry-run watch：用 FakeClient，写入 sqlite in-memory")
        engine = db_mod.make_engine("sqlite:///:memory:")
        db_mod.create_all(engine)
        session_factory = db_mod.make_session_factory(engine)
        fake = mocks.FakeClient()

        async def processor(short_name: str) -> None:
            await pipeline.crawl_single_pack(
                fake, short_name, session_factory, cfg.thumbnail_dir,
                download_originals=do_originals, media_dir=cfg.media_dir,
            )

        # dry-run 模式只扫一次 + 退出，避免 CI 死循环
        n = await signals.scan_once(cfg.signals_dir, processor)
        log.info("dry-run 扫描完成，处理 %d 个信号", n)
        return 0

    engine = db_mod.make_engine(cfg.db_dsn)
    session_factory = db_mod.make_session_factory(engine)
    client = await client_mod.get_client(cfg)

    async def processor(short_name: str) -> None:
        await pipeline.crawl_single_pack(
            client, short_name, session_factory, cfg.thumbnail_dir,
                download_originals=do_originals, media_dir=cfg.media_dir,
                r2_base_url=cfg.r2_base_url,
        )

    try:
        _start_health_server()
        if os.getenv("CRAWLER_INITIAL_FULL") == "1":
            with session_factory() as session:
                pack_count = session.query(db_mod.StickerPack).count()
            if pack_count == 0:
                log.info("数据库为空，开始首次全量抓取")
                stats = await pipeline.run_full_crawl(
                    client, session_factory, cfg.thumbnail_dir,
                    download_originals=do_originals, media_dir=cfg.media_dir,
                    r2_base_url=cfg.r2_base_url,
                )
                log.info("首次全量抓取统计 %s", stats)
        if cfg.r2_base_url:
            await signals.watch_r2_loop(cfg.r2_base_url, processor)
        else:
            await signals.watch_loop(cfg.signals_dir, processor)
        return 0
    finally:
        await client_mod.disconnect_safely(client)


def _start_health_server() -> None:
    """Optional HTTP readiness endpoint used by the Cloudflare Container Worker."""
    raw_port = os.getenv("CRAWLER_HEALTH_PORT", "").strip()
    if not raw_port:
        return
    port = int(raw_port)

    class HealthHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path != "/healthz":
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("0.0.0.0", port), HealthHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="crawler", description="tg-emoji-hub Telegram 爬虫")
    p.add_argument("--dry-run", action="store_true",
                   help="用 FakeClient + sqlite in-memory，不联网不入库")
    sub = p.add_subparsers(dest="cmd", required=True)
    # 子 parser 重复声明 --dry-run，让 `crawler.py full --dry-run` 也能识别
    full_p = sub.add_parser("full", help="全量爬取 Featured + manual")
    full_p.add_argument("--dry-run", action="store_true",
                        help="用 FakeClient + sqlite in-memory，不联网不入库")
    full_p.add_argument("--no-thumbs", action="store_true",
                        help="跳过缩略图下载，仅入元数据（快速建库；图后续 watch 阶段补）")
    full_p.add_argument("--no-originals", action="store_true",
                        help="跳过原文件下载（webp/webm/tgs），动态 emoji 前端只能显示静态缩略图")
    watch_p = sub.add_parser("watch", help="监听 signals/ 目录")
    watch_p.add_argument("--dry-run", action="store_true",
                         help="用 FakeClient + sqlite in-memory，不联网不入库")
    watch_p.add_argument("--no-originals", action="store_true",
                         help="跳过原文件下载")
    sub.add_parser("login", help="首次 Telegram 登录并保存本地 SQLite session")
    sub.add_parser("login-qr", help="使用已登录的 Telegram 手机客户端扫码登录")
    export_p = sub.add_parser("export-session-string", help="导出 Cloudflare 用的 StringSession")
    export_p.add_argument("--output", default=None, help="输出文件；默认写入 SESSION_DIR")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    cfg = load_config(require_tg=not getattr(args, "dry_run", False))
    configure_logging(cfg.log_level)

    if args.cmd == "login":
        asyncio.run(client_mod.login_interactive(cfg))
        return 0
    if args.cmd == "login-qr":
        asyncio.run(client_mod.login_qr(cfg))
        return 0
    if args.cmd == "export-session-string":
        output = asyncio.run(client_mod.export_session_string(cfg, args.output))
        log.info("StringSession 已写入权限为 0600 的本地文件：%s", output)
        return 0

    if args.cmd == "full":
        return asyncio.run(cmd_full(
            cfg, dry_run=args.dry_run,
            no_thumbs=getattr(args, "no_thumbs", False),
            no_originals=getattr(args, "no_originals", False),
        ))
    if args.cmd == "watch":
        return asyncio.run(cmd_watch(
            cfg, dry_run=args.dry_run,
            no_originals=getattr(args, "no_originals", False),
        ))
    return 2


if __name__ == "__main__":
    sys.exit(main())
