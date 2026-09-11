"""Cliente HTTP Digest mínimo para o painel local do SM-WU.

O firmware V5.10 usa um desafio Digest que alguns clientes rejeitam por causa
do HTML presente no realm. Este utilitário mantém a comunicação local e permite
fixar o endereço de origem do adaptador USB.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import re
import secrets
import sys
from urllib.parse import urlsplit


def md5(value: str) -> str:
    return hashlib.md5(value.encode("utf-8")).hexdigest()


def challenge_values(header: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for key, quoted, plain in re.findall(r'(\w+)=(?:"([^"]*)"|([^,\s]+))', header):
        values[key.lower()] = quoted or plain
    return values


def request(
    url: str,
    method: str,
    username: str,
    password: str,
    source: str | None,
    body: bytes | None,
) -> tuple[int, bytes]:
    parsed = urlsplit(url)
    if parsed.scheme != "http" or not parsed.hostname:
        raise ValueError("Somente URLs HTTP locais são aceitas.")

    target = parsed.path or "/"
    if parsed.query:
        target += "?" + parsed.query
    source_address = (source, 0) if source else None

    first = http.client.HTTPConnection(
        parsed.hostname,
        parsed.port or 80,
        timeout=10,
        source_address=source_address,
    )
    # Busque o nonce com GET vazio. Alguns firmwares aplicam parcialmente um
    # POST antes de devolver o 401, o que pode limpar checkboxes do formulário.
    first.request("GET", target, headers={"Connection": "close"})
    response = first.getresponse()
    first_content = response.read()
    challenge = response.getheader("WWW-Authenticate", "")
    first.close()

    if response.status != 401 or not challenge.lower().startswith("digest "):
        return response.status, first_content

    values = challenge_values(challenge)
    realm = values["realm"]
    nonce = values["nonce"]
    qop = "auth"
    nonce_count = "00000001"
    client_nonce = secrets.token_hex(8)
    digest = md5(
        f"{md5(f'{username}:{realm}:{password}')}:{nonce}:{nonce_count}:"
        f"{client_nonce}:{qop}:{md5(f'{method}:{target}')}"
    )
    fields = [
        f'username="{username}"',
        f'realm="{realm}"',
        f'nonce="{nonce}"',
        f'uri="{target}"',
        f'response="{digest}"',
        f'qop={qop}',
        f'nc={nonce_count}',
        f'cnonce="{client_nonce}"',
    ]
    if "opaque" in values:
        fields.append(f'opaque="{values["opaque"]}"')

    headers = {
        "Authorization": "Digest " + ", ".join(fields),
        "Connection": "close",
    }
    if body is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        headers["Content-Length"] = str(len(body))

    connection = http.client.HTTPConnection(
        parsed.hostname,
        parsed.port or 80,
        timeout=10,
        source_address=source_address,
    )
    connection.request(method, target, body=body, headers=headers)
    response = connection.getresponse()
    content = response.read()
    status = response.status
    connection.close()
    return status, content


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--method", choices=["GET", "POST"], default="GET")
    parser.add_argument("--user", default="admin")
    parser.add_argument("--password", default="admin")
    parser.add_argument("--source")
    parser.add_argument("--data", default=None)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    body = args.data.encode("utf-8") if args.data is not None else None
    status, content = request(
        args.url,
        args.method,
        args.user,
        args.password,
        args.source,
        body,
    )
    print(status)
    if content and not args.quiet:
        sys.stdout.buffer.write(content)
        if not content.endswith(b"\n"):
            print()
    return 0 if 200 <= status < 400 else 1


if __name__ == "__main__":
    raise SystemExit(main())
