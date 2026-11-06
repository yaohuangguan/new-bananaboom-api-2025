#!/usr/bin/env python3
"""Conservative, read-only Orion Cloud Run retirement inventory."""
from collections import Counter
from pathlib import Path
import argparse
import re
import sys
import tomllib

ROOT=Path(__file__).resolve().parents[1]
FRONTEND=ROOT.parent/'orion-frontend'
METHOD=re.compile(r"\brouter\.(get|post|put|patch|delete|all)\(\s*(['\"])(.*?)\2",re.S|re.I)
MOUNT=re.compile(r"app\.use\(\s*(['\"])(/api/[^'\"]+)\1\s*,\s*(\w+)")
IMP=re.compile(r"import\s+(\w+)\s+from\s+['\"](\./routes/[^'\"]+\.js)['\"]")
INCORE=re.compile(r"from\s+['\"](\.\.?/[^'\"]+)['\"]")

FLAGS={
  'GET /api/users/profile':'PROFILE_READ_CUTOVER',
  'GET /api/users/ai-status':'PROFILE_READ_CUTOVER',
  'GET /api/todos':'TODO_READ_CUTOVER',
  'GET /api/footprints':'FOOTPRINT_READ_CUTOVER',
  'GET /api/footprints/:id':'FOOTPRINT_DETAIL_CUTOVER',
  'POST /api/posts':'ARTICLE_WRITE_CUTOVER',
  'PUT /api/posts/:id':'ARTICLE_WRITE_CUTOVER',
  'DELETE /api/posts/:id':'ARTICLE_WRITE_CUTOVER',
}
CORE_READ={'/api/homepage','/api/homepage/likes','/api/homepage/projects',
 '/api/homepage/logs','/api/projects','/api/posts','/api/menu','/api/tags',
 '/api/photos','/api/resumes','/api/resumes/list'}

def status(method,path,flags):
    canonical=re.sub(r"/:[\w]+","/:id",path)
    if canonical.startswith(('/api/chat/public','/api/chat/private','/api/payments')):
        return 'retired-gateway-410'
    if canonical=='/api/backup/database' and method=='POST':
        return 'worker-live' if flags.get('BACKUP_R2_CUTOVER')=='1' else 'legacy-default'
    if method=='GET' and canonical in CORE_READ:
        return 'worker-read-with-possible-legacy-fallback'
    flag=FLAGS.get(method+' '+canonical)
    if flag:
        return 'worker-live' if flags.get(flag)=='1' else 'worker-canary-legacy-default'
    return 'legacy-default-or-unverified'

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--write',action='store_true')
    parser.add_argument('--require-zero-legacy',action='store_true')
    opts=parser.parse_args()
    flags=tomllib.loads((ROOT/'cloudflare/orion-api-gateway/wrangler.toml').read_text())['vars']
    index=(ROOT/'index.js').read_text()
    imported=dict(IMP.findall(index))
    rows=set()
    for _,prefix,name in MOUNT.findall(index):
        if name not in imported: continue
        target=ROOT/imported[name][2:]
        if not target.exists(): continue
        for method,_,suffix in METHOD.findall(target.read_text()):
            if not suffix.startswith('/'): continue
            full=prefix.rstrip('/') + (suffix if suffix!='/' else '')
            rows.add((method.upper(),full,str(target.relative_to(ROOT))))
    rows=sorted(rows)
    classified=[(*row,status(row[0],row[1],flags)) for row in rows]
    counts=Counter(row[3] for row in classified)
    legacy_imports=set()
    for p in (ROOT/'cloudflare/bananaboom-worker/src').glob('*.js'):
        for imported in INCORE.findall(p.read_text()):
            dep=(p.parent/imported).resolve()
            if ROOT in dep.parents and ROOT/'cloudflare' not in dep.parents:
                legacy_imports.add((str(p.relative_to(ROOT)),str(dep.relative_to(ROOT))))
    front=set()
    for p in (FRONTEND/'services').glob('*.ts'):
        for m in re.findall(r"(?:fetchClient|brainRequest|fetchEventStream)\s*(?:<[^>]+>)?\s*\(\s*['\"](/[^'\"]+)['\"]",p.read_text()):
            front.add((m,str(p.relative_to(FRONTEND))))
    lines=['# Cloud Run route retirement inventory','',
       'Generated from source by scripts/audit-orion-route-ownership.py.',
       'STATIC CODE DISCOVERY ONLY: dynamic OAuth SDK routes, body shape, runtime',
       'traffic, effective RBAC and frontend dynamic URLs require separate audits.','',
       '## Summary','',
       '- Express route declarations: '+str(len(rows)),
       '- Static frontend service endpoint references: '+str(len(front)),
       '- Direct imports from old server source into Core Worker: '+str(len(legacy_imports)),
       '- Legacy/default or unverified: '+str(counts['legacy-default-or-unverified']),
       '- Worker canary but default Cloud Run: '+str(counts['worker-canary-legacy-default']),
       '- Eligible Worker read with possible fallback: '+str(counts['worker-read-with-possible-legacy-fallback']),
       '- Explicit Worker-live: '+str(counts['worker-live']),'',
       'These numbers are a lower bound; do NOT turn off Cloud Run based on this file.','',
       '## Core Worker directly imports these old server modules','',
       '| Core source | Old-server source |','| --- | --- |']
    lines += ['| '+a+' | '+b+' |' for a,b in sorted(legacy_imports)]
    lines += ['','## Special routes not counted by the simple Express scan','',
       '- /authorize, /token, /register, /revoke: services/brain/oauth.js (MCP PKCE/OAuth)',
       '- /.well-known/oauth-*: services/brain/oauth.js (discovery)',
       '- /api/brain/sync/mcp: routes/brainSync.js (MCP protocol + auth)',
       '- /api/brain/sync/v1/*: routes/brainSync.js (knowledge sync)',
       '- /api/brain/*: routes/brain.js and services/brain/* (memory, imports, export, restore)',
       '- /socket.io: retired human chat; Gateway blocks endpoint','',
       '## Express routes detected','',
       '| Method | Path | Static owner status | Implementation |',
       '| --- | --- | --- | --- |']
    lines+=['| '+method+' | '+path+' | '+state+' | '+source+' |'
            for method,path,source,state in classified]
    lines+=['','## Frontend static call sites','',
            '| Endpoint suffix | Service file |','| --- | --- |']
    lines+=['| '+path+' | '+file+' |' for path,file in sorted(front)]
    lines+=['','## Binary retirement gate','',
            'FAIL while any required legacy route, OAuth callback, MCP client,',
            'upload, scheduled task or frontend network call still needs Cloud Run.',
            'Only after API parity, production zero-upstream observation over rare',
            'paths, and a reversible shutdown rehearsal may Cloud Run be retired.',
            '']
    if opts.write:
        out=ROOT/'docs/LEGACY-ROUTE-INVENTORY.md'
        out.write_text('\n'.join(lines))
        print('Wrote',out)
    print('Routes',len(rows),'legacy',counts['legacy-default-or-unverified'],
          'canary',counts['worker-canary-legacy-default'],
          'worker read',counts['worker-read-with-possible-legacy-fallback'],
          'external imports',len(legacy_imports))
    if opts.require_zero_legacy and (
        counts['legacy-default-or-unverified'] or
        counts['worker-canary-legacy-default']
    ):
        print('CLOUD_RUN_RETIREMENT_GATE=FAIL')
        return 1
    return 0

if __name__=='__main__':
    sys.exit(main())
