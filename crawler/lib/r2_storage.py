"""Minimal client for the private R2 gateway bound to Cloudflare Containers."""

from __future__ import annotations

import asyncio
import json
import mimetypes
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


def _request(url: str, method: str, data: bytes | None = None,
             content_type: str = "application/octet-stream") -> bytes:
    req = Request(url, data=data, method=method, headers={"Content-Type": content_type})
    try:
        with urlopen(req, timeout=30) as resp:
            return resp.read()
    except HTTPError as exc:
        if exc.code == 404:
            return b""
        raise RuntimeError(f"R2 gateway returned HTTP {exc.code}") from exc
    except URLError as exc:
        raise RuntimeError("R2 gateway request failed") from exc


def _object_url(base_url: str, key: str) -> str:
    return f"{base_url}/{quote(key, safe='/') }"


async def upload_file(base_url: str, prefix: str, path: Path) -> None:
    data = await asyncio.to_thread(path.read_bytes)
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    await asyncio.to_thread(_request, _object_url(base_url, f"{prefix}/{path.name}"),
                            "PUT", data, content_type)


async def list_keys(base_url: str, prefix: str) -> list[str]:
    url = f"{base_url}/_list?{urlencode({'prefix': prefix + '/'})}"
    body = await asyncio.to_thread(_request, url, "GET")
    if not body:
        return []
    return list(json.loads(body).get("keys", []))


async def get_object(base_url: str, key: str) -> bytes:
    return await asyncio.to_thread(_request, _object_url(base_url, key), "GET")


async def put_object(base_url: str, key: str, data: bytes) -> None:
    await asyncio.to_thread(_request, _object_url(base_url, key), "PUT", data, "application/json")


async def delete_object(base_url: str, key: str) -> None:
    await asyncio.to_thread(_request, _object_url(base_url, key), "DELETE")
