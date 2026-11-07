#!/usr/bin/env python3
"""Verify exact ciphertext parity between Orion's GCS regions, never decrypt."""
import concurrent.futures
import hashlib
import re
import subprocess
import sys
from pathlib import Path

GCLOUD = '/home/samyao/google-cloud-sdk/bin/gcloud'
SOURCE = 'orion-memory-vault-242273127238'
TARGET = 'orion-brain-vault-us-242273127238'
KEY_RE = re.compile(r'^[0-9a-f]{24}/[0-9a-f]{64}$')

def run(*args):
    p = subprocess.run((GCLOUD, 'storage', *args, '--quiet'),
                       capture_output=True, timeout=60)
    if p.returncode:
        raise RuntimeError('GCS command failed (details intentionally redacted)')
    return p.stdout

def list_keys(bucket):
    prefix = 'gs://' + bucket + '/'
    raw = run('ls', '--recursive', 'gs://' + bucket + '/**')
    keys = []
    for line in raw.decode('utf-8').splitlines():
        uri = line.strip()
        if not uri or uri.startswith('TOTAL') or uri.endswith('/'):
            continue
        if not uri.startswith(prefix):
            raise RuntimeError('Unexpected bucket listing')
        key = uri[len(prefix):]
        if not KEY_RE.fullmatch(key):
            raise RuntimeError('Unexpected object key; abort')
        keys.append(key)
    if len(keys) != len(set(keys)):
        raise RuntimeError('Duplicate object in listing')
    return sorted(keys)

def verify_one(key):
    x = run('cat', 'gs://' + SOURCE + '/' + key)
    y = run('cat', 'gs://' + TARGET + '/' + key)
    if not x.startswith(b'ORIONV1\n') or not y.startswith(b'ORIONV1\n'):
        raise RuntimeError('Encrypted envelope corrupted')
    src_sha = hashlib.sha256(x).hexdigest()
    dst_sha = hashlib.sha256(y).hexdigest()
    if len(x) != len(y) or src_sha != dst_sha:
        raise RuntimeError('Ciphertext SHA-256 or length mismatch')
    return src_sha, len(x)

def main():
    source = list_keys(SOURCE)
    target = list_keys(TARGET)
    if not source or source != target:
        raise RuntimeError('GCS object key sets differ; rerun rsync and verify')
    print('CHECKED_OBJECT_KEYS', len(source), flush=True)
    found = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for result in pool.map(verify_one, source):
            found.append(result)
            if len(found) % 10 == 0 or len(found) == len(source):
                print('CIPHERTEXT_SHA256_VERIFIED',len(found),'/',len(source),flush=True)
    if source != list_keys(SOURCE) or target != list_keys(TARGET):
        raise RuntimeError('Source or destination changed during verification')
    total = sum(size for _,size in found)
    digest = hashlib.sha256(''.join(sorted(sha for sha,_ in found)).encode()).hexdigest()
    print('US_GCS_ENCRYPTED_MIGRATION_VERIFIED objects',len(found),'bytes',total,flush=True)
    print('AGGREGATE_OBJECT_DIGEST',digest,flush=True)
    print('NO_DECRYPTION=true; NO_DELETION=true',flush=True)

if __name__=='__main__':
    try:
        main()
    except Exception as err:
        print('VERIFICATION_FAILED:',str(err)[:120], file=sys.stderr)
        sys.exit(1)
