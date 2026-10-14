"""Validate an operator-owned SQL export in a disposable DB; never restore a live DB."""
import json
import pathlib
import sqlite3
import sys
import tempfile

def validate(source):
    path = pathlib.Path(source).resolve(strict=True)
    if path.suffix.lower() != '.sql' or path.stat().st_size > 128 * 1024 * 1024:
        raise ValueError('Unsupported input')
    with tempfile.TemporaryDirectory(prefix='hidra-restore-check-') as temporary:
        db = sqlite3.connect(pathlib.Path(temporary) / 'disposable.sqlite')
        db.enable_load_extension(False)
        def authorize(operation, arg1, arg2, *_):
            if operation in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
                return sqlite3.SQLITE_DENY
            if operation == sqlite3.SQLITE_FUNCTION and arg2 in ('load_extension', 'writefile', 'readfile'):
                return sqlite3.SQLITE_DENY
            if operation == sqlite3.SQLITE_PRAGMA and arg1 == 'writable_schema':
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        db.set_authorizer(authorize)
        db.executescript(path.read_text(encoding='utf-8'))
        integrity = db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        foreign_keys = len(db.execute('PRAGMA foreign_key_check').fetchall())
        if not integrity or foreign_keys:
            raise ValueError('Integrity failure')
        db.close()
        return {'integrity': 'ok', 'foreign_key_violations': 0, 'live_database_modified': False}

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Usage')
        print(json.dumps(validate(sys.argv[1])))
    except Exception:
        print('Exportação inválida ou não suportada. Nenhum banco existente foi alterado.', file=sys.stderr)
        sys.exit(1)
