#!/usr/bin/env python3
"""Offline verifier/reader/extractor. Python 3 standard library only; never network."""
import sys, io, zipfile, hashlib, json, pathlib, stat, os, re
TABLES = ('sources', 'documents', 'memories', 'revisions', 'assets')
def check(condition, code):
    if not condition: raise ValueError(code)
def safe_name(name):
    check(name and len(name) <= 512 and not name.startswith('/') and '\\' not in name and ':' not in name
          and all(ord(c) >= 32 and ord(c) != 127 for c in name)
          and all(p not in ('.', '..', '') for p in name.split('/')), 'UNSAFE_PATH')
def parse(raw):
    def pairs(items):
        out = {}
        for k, v in items:
            check(k not in out and k not in ('__proto__', 'constructor', 'prototype') and not k.startswith('$'), 'UNSAFE_JSON')
            out[k] = v
        return out
    value = json.loads(raw, object_pairs_hook=pairs)
    stack, nodes = [(value, 0)], 0
    while stack:
        item, depth = stack.pop(); nodes += 1
        check(depth <= 64 and nodes <= 500000, 'JSON_QUOTA')
        if isinstance(item, dict): stack.extend((v, depth + 1) for v in item.values())
        elif isinstance(item, list): stack.extend((v, depth + 1) for v in item)
    return value
def validate(data):
    check(len(data) <= 128 * 1024 * 1024, 'ARCHIVE_TOO_LARGE')
    files, total = {}, 0
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        check(len(archive.infolist()) <= 2000, 'FILE_COUNT_QUOTA')
        for info in archive.infolist():
            safe_name(info.filename)
            check(not info.is_dir() and info.filename not in files and not stat.S_ISLNK(info.external_attr >> 16), 'INVALID_ENTRY')
            total += info.file_size
            check(info.file_size <= 32 * 1024 * 1024 and total <= 100 * 1024 * 1024
                  and info.file_size / max(1, info.compress_size) <= 200 and not info.flag_bits & 1, 'ZIP_QUOTA')
            files[info.filename] = archive.read(info)
    check('manifest.json' in files and 'checksums.sha256' in files, 'MISSING_MANIFEST')
    manifest = parse(files['manifest.json'])
    check(manifest.get('schemaVersion') == 1 and re.fullmatch('[a-f0-9]{24}', manifest.get('owner', '')), 'SCHEMA_OR_OWNER')
    expected = manifest.get('hashes', {})
    check(set(expected) == set(files) - {'manifest.json', 'checksums.sha256'}, 'FILE_INVENTORY')
    digest = lambda b: hashlib.sha256(b).hexdigest()
    for name, checksum in expected.items(): check(checksum == digest(files[name]), 'HASH_MISMATCH')
    checks = {}
    for line in files['checksums.sha256'].decode('utf-8').splitlines():
        checksum, name = line.split('  ', 1)
        check(name not in checks, 'DUPLICATE_CHECKSUM'); checks[name] = checksum
    check(set(checks) == set(files) - {'checksums.sha256'}, 'CHECKSUM_INVENTORY')
    for name, checksum in checks.items(): check(digest(files[name]) == checksum, 'CHECKSUM_MISMATCH')
    rows = {}
    for table in TABLES:
        rows[table] = [parse(line) for line in files[table + '.jsonl'].decode('utf-8').splitlines() if line]
        check(len(rows[table]) == manifest['counts'][table] and len(rows[table]) <= 10000, 'COUNT_MISMATCH')
        seen = set()
        for row in rows[table]:
            check(row.get('ownerId') == manifest['owner'] and re.fullmatch('[a-f0-9]{24}', row.get('_id', '')), 'ROW_OWNER')
            check(row['_id'] not in seen, 'DUPLICATE_ID'); seen.add(row['_id'])
    ids = {name: {row['_id'] for row in group} for name, group in rows.items()}
    docs = {d['_id']: d for d in rows['documents']}
    for source in rows['sources']:
        check(source.get('originalPath') == 'originals/' + source['originalSha256'] and source['originalPath'] in files and digest(files[source['originalPath']]) == source['originalSha256'], 'ORIGINAL_HASH')
    for asset in rows['assets']:
        check(asset['sourceId'] in ids['sources'], 'ASSET_SOURCE')
        if asset.get('availability') == 'available':
            check(asset.get('archivePath') == 'assets/' + asset['sha256'] and asset.get('archivePath') in files and digest(files[asset['archivePath']]) == asset['sha256'] and len(files[asset['archivePath']]) == asset['size'], 'ASSET_HASH')
    for doc in rows['documents']: check(doc['sourceId'] in ids['sources'] and all(a in ids['assets'] for a in doc.get('assetIds', [])), 'DOCUMENT_REFERENCE')
    revisions_by_memory = {}
    for revision in rows['revisions']: revisions_by_memory.setdefault(revision['memoryId'], []).append(revision)
    for memory in rows['memories']:
        check(memory['sourceId'] in ids['sources'], 'MEMORY_SOURCE')
        for anchor in memory.get('sourceAnchors', []):
            check(anchor['documentId'] in docs, 'MEMORY_DOCUMENT')
            if 'quote' in anchor: check(anchor['quote'] in docs[anchor['documentId']]['rawText'], 'ANCHOR_QUOTE')
        revisions = sorted(revisions_by_memory.get(memory['_id'], []), key=lambda r: r['revisionNumber'])
        check(len(revisions) == memory['revision'] and revisions[-1]['after'] == memory, 'REVISION_CHAIN')
        for i, revision in enumerate(revisions):
            check(revision['revisionNumber'] == i + 1 and revision['actorId'] == manifest['owner']
                  and revision['after']['ownerId'] == manifest['owner'] and revision['after']['_id'] == memory['_id']
                  and (i == 0 or revision.get('before') == revisions[i - 1]['after']), 'REVISION_CHAIN')
    for revision in rows['revisions']: check(revision['memoryId'] in ids['memories'], 'REVISION_REFERENCE')
    return manifest, files, rows
def main():
    command = sys.argv[1]
    manifest, files, rows = validate(sys.stdin.buffer.read(128 * 1024 * 1024 + 1))
    if command != 'verify':
        destination = pathlib.Path(sys.argv[2]).absolute()
        destination.mkdir(mode=0o700, parents=False, exist_ok=False)
        marker = destination / 'RECOVERY_INCOMPLETE'; marker.write_text('Do not use until this marker is removed.\n', encoding='utf-8')
        for name, content in files.items():
            target = destination.joinpath(*name.split('/')); target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with target.open('xb') as handle: os.chmod(target, 0o600); handle.write(content)
        for table, field in [('memories', 'statement'), ('documents', 'rawText')]:
            with (destination / (table + '-readable.txt')).open('x', encoding='utf-8') as handle:
                os.chmod(handle.name, 0o600)
                for row in rows[table]:
                    handle.write(json.dumps({'id': row['_id'], 'date': row.get('eventAt', row.get('rawTimestamp')), 'sourceId': row.get('sourceId')}, ensure_ascii=False) + '\n')
                    handle.write(row.get(field, '') + '\n\n')
        marker.unlink()
    print(json.dumps({'verified': True, 'schemaVersion': manifest['schemaVersion'], 'counts': manifest['counts'], 'filesVerified': len(files), 'offline': True}, sort_keys=True))
if __name__ == '__main__':
    try: main()
    except Exception: print('ARCHIVE_VALIDATION_OR_RESTORE_FAILED', file=sys.stderr); sys.exit(1)
