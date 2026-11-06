#!/usr/bin/env python3
"""Copy Orion Brain *encrypted* immutable GCS blobs into private R2.

Authoritative GCS originals are never edited/deleted. No decrypted bytes,
owner IDs, filenames, object keys, tokens or credential values are logged.
Requires the already-authenticated local gcloud and Wrangler CLIs. Uses only
in-memory streaming; no plaintext/ciphertext temporary files.
"""
import argparse, concurrent.futures, hashlib, os, re, subprocess, sys, threading, time
from pathlib import Path

SRC_BUCKET = 'orion-memory-vault-242273127238'
DST_BUCKET = 'orion-private-memory-vault'
ROOT = Path(__file__).resolve().parents[1]
GCLOUD = Path('/home/samyao/google-cloud-sdk/bin/gcloud')
NODE = Path('/home/samyao/.nvm/versions/node/v24.21.0/bin/node')
WRANGLER = ROOT / 'cloudflare/bananaboom-worker/node_modules/wrangler/bin/wrangler.js'
CANONICAL = re.compile(r'^[a-f0-9]{24}/[a-f0-9]{64}$')
R2_ARGS = [str(NODE), str(WRANGLER), 'r2', 'object']

def invoke(args, data=None, seconds=70):
    p = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=seconds, cwd=str(ROOT/'cloudflare/bananaboom-worker'))
    return p

def get_source_list():
    result=invoke([str(GCLOUD),'storage','ls','--recursive',
                   f'gs://{SRC_BUCKET}/**','--quiet'],seconds=90)
    if result.returncode:
        raise RuntimeError('GCS listing failed (details deliberately redacted)')
    entries=[]
    prefix=f'gs://{SRC_BUCKET}/'
    for line in result.stdout.decode('utf-8').splitlines():
        item=line.strip()
        if not item or item.endswith('/') or item.startswith('TOTAL'): continue
        if not item.startswith(prefix):
            raise RuntimeError('Unexpected GCS listing output')
        key=item[len(prefix):]
        if not CANONICAL.fullmatch(key):
            raise RuntimeError('Unsafe/non-canonical source object path; aborting')
        entries.append(key)
    if len(set(entries)) != len(entries) or not entries:
        raise RuntimeError('Duplicate or empty source listing')
    return sorted(entries)

def get_r2(key):
    p=invoke(R2_ARGS+['get',f'{DST_BUCKET}/{key}','--remote','--pipe'],seconds=80)
    return p.stdout if p.returncode==0 else None

def copy_one(key):
    for attempt in range(3):
        try:
            src=invoke([str(GCLOUD),'storage','cat',f'gs://{SRC_BUCKET}/{key}','--quiet'],seconds=70)
            if src.returncode: raise RuntimeError('Source read failed')
            data=src.stdout
            if len(data)<52 or not data.startswith(b'ORIONV1\n'):
                raise RuntimeError('Non-encrypted or malformed legacy blob; stop')
            sha=hashlib.sha256(data).hexdigest()
            existing=get_r2(key)
            if existing is not None:
                if hashlib.sha256(existing).hexdigest()!=sha or len(existing)!=len(data):
                    raise RuntimeError('R2 destination already exists but mismatches source; stop')
                return ('present',len(data),sha)
            p=invoke(R2_ARGS+['put',f'{DST_BUCKET}/{key}','--remote','--pipe',
                               '--content-type','application/octet-stream'],data=data,seconds=90)
            if p.returncode: raise RuntimeError('R2 write failed')
            verified=get_r2(key)
            if verified is None or hashlib.sha256(verified).hexdigest()!=sha or len(verified)!=len(data):
                raise RuntimeError('R2 read-after-write hash mismatch')
            return ('copied',len(data),sha)
        except RuntimeError as exc:
            if 'mismatch' in str(exc).lower() or 'malformed' in str(exc).lower():
                raise
            if attempt == 2: raise RuntimeError('Object migration failed after retries')
            time.sleep((attempt+1)*2)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--commit',action='store_true',
        help='Copy and verify bytes; default is metadata-only dry-run')
    parser.add_argument('--workers',type=int,choices=range(1,7),default=4)
    args=parser.parse_args()
    if not (GCLOUD.is_file() and NODE.is_file() and WRANGLER.is_file()):
        raise RuntimeError('Required local CLI is missing')
    keys=get_source_list()
    print('SOURCE_OBJECT_COUNT',len(keys),flush=True)
    print('DESTINATION_BUCKET_PRIVATE',DST_BUCKET,flush=True)
    if not args.commit:
        print('DRY_RUN: no object data read or written. Use --commit for encrypted backfill.')
        return
    results=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_map={executor.submit(copy_one,key):key for key in keys}
        for fut in concurrent.futures.as_completed(future_map):
            results.append(fut.result())
            if len(results)%10==0 or len(results)==len(keys):
                print('VERIFIED_ENCRYPTED_OBJECTS',len(results),'/',len(keys),flush=True)
    # Confirm listing did not change in transit; new legacy writes require a rerun.
    end_keys=get_source_list()
    if end_keys!=keys:
        raise RuntimeError('New GCS object appeared during copy; rerun backfill')
    total=sum(size for _,size,_ in results)
    manifest=hashlib.sha256(''.join(sorted(sha for _,_,sha in results)).encode()).hexdigest()
    print('MIGRATION_PASS objects',len(results),'bytes',total,
          'copied',sum(status=='copied' for status,_,_ in results),
          'preexisting',sum(status=='present' for status,_,_ in results))
    print('CIPHERTEXT_DIGEST_SUMMARY',manifest)
    print('GCS_ORIGINALS_PRESERVED=true; NO_DECRYPTION=true; NO_DELETION=true')

if __name__=='__main__':
    try: main()
    except Exception as e:
        # Do not print paths, credentials or raw tool stderr.
        print('MIGRATION_ABORTED:',str(e).splitlines()[0][:120],file=sys.stderr)
        sys.exit(1)
