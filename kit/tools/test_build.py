#!/usr/bin/env python3
"""build.py's generated files, without BMW's SDK: the iDrive 7 UI description, strings and SOME/IP manifest
must stay exactly as they were before iDrive 8 support (kit/tools/snapshots/<app>/), and the iDrive 8 ones
must follow Hmi8's rules.

    python3 kit/tools/test_build.py            # check
    python3 kit/tools/test_build.py --write    # (re)write the iDrive 7 snapshots: only for a wanted change
"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build  # noqa: E402
from localize import unicode_resources, localize_spec  # noqa: E402

SNAP = os.path.join(HERE, 'snapshots')
APPS = sorted(d for d in os.listdir(build.APPS) if os.path.exists(os.path.join(build.APPS, d, 'app.json')))


def spec_of(app_id, language='en'):
    spec = json.load(open(os.path.join(build.APPS, app_id, 'app.json'), encoding='utf-8'))
    spec = localize_spec(spec, language)
    spec.setdefault('id', app_id)
    return spec


def id7(app_id):
    """What build() writes for iDrive 7: application.xml, uiDescription.json, the strings, manifest.json."""
    spec = spec_of(app_id)
    manifest = build.manifest_for(json.loads(json.dumps(spec)))
    xml, uidesc, strings, state_ids = build.build_ui(spec, 'en')
    unicode_resources(uidesc, strings, 'en')
    return {
        'ID7.application.xml': xml,
        'ID7.uiDescription.json': json.dumps(uidesc, indent=1, ensure_ascii=False) + '\n',
        'strings.en.json': json.dumps(strings, indent=1, ensure_ascii=False, sort_keys=True) + '\n',
        'manifest.ID7.json': json.dumps(manifest, indent=2, sort_keys=True) + '\n',
    }


def check(name, ok, why=''):
    print(('ok    ' if ok else 'FAIL  ') + name + ('' if ok else ': ' + why))
    return 0 if ok else 1


def id8(app_id):
    """The iDrive 8 description and manifest follow what Hmi8 and MainApp-21 take."""
    import re, shutil, tempfile
    spec = spec_of(app_id)
    xml, ui, state_ids = build.build_ui_id8(spec)
    xml7, ui7, strings, _ = build.build_ui(spec, 'en')
    failed = 0
    failed += check(app_id + ': ID8 states have no parent (property 9)', 'property id="9"' not in xml and 'ParentState' not in json.dumps(ui))
    widgets = set(re.findall(r'widget="([^"]+)"', xml))
    failed += check(app_id + ': ID8 uses only widgets seen in iDrive 8 descriptions', widgets <= {'LT_State_Wide_List', 'LT_ScrollLabel'}, str(widgets))
    names = [c['name'] for cont in ui['containers'].values() for c in cont['components'].values()]
    failed += check(app_id + ': ID8 has the marker and the note', build.ID8_MARKER in names and build.ID8_NOTE in names, str(names))
    failed += check(app_id + ': ID8 has no graphic, bar button or settings', not re.search(r'Graphic|dropDownMenu|checkBox|type="button"', xml + json.dumps(ui)))
    canvas = [s['name'] for s in spec.get('screens', []) if s.get('kind') == 'canvas']
    failed += check(app_id + ': ID8 has a host state per canvas screen', sorted(state_ids) == sorted(canvas), str(state_ids))
    sids = [c['rows'][0]['Text']['value'] for cont in ui['containers'].values() for c in cont['components'].values() if c['type'] == 'title']
    failed += check(app_id + ': ID8 titles use strings the ID7 description defines', all(s in strings for s in sids), str(sids))
    # a setting for iDrive 8 only ("hmi": ["ID8"]) has no row in the iDrive 7 description, and reaches the app
    only8 = [s['key'] for s in spec.get('settings', []) if s.get('hmi') and 'ID7' not in s['hmi']]
    names7 = [c['name'] for cont in ui7['containers'].values() for c in cont['components'].values()]
    failed += check(app_id + ': iDrive 8 only settings are not in the ID7 description', not any('SET_' + k.upper() in names7 for k in only8), str(only8))
    with7 = dict(spec, settings=[dict(s, hmi=['ID7', 'ID8']) if s['key'] in only8 else s for s in spec.get('settings', [])])
    names_all = [c['name'] for cont in build.build_ui(with7, 'en')[1]['containers'].values() for c in cont['components'].values()]
    failed += check(app_id + ': a setting for both HMIs is in the ID7 description', all('SET_' + k.upper() in names_all for k in only8))
    # the fallback should Hmi8 refuse the labels: the bare host state (a title only)
    bare_xml, bare_ui, _ = build.build_ui_id8(dict(spec, id8Labels=False))
    bare = [c['type'] for cont in bare_ui['containers'].values() for c in cont['components'].values()]
    failed += check(app_id + ': ID8 with "id8Labels": false is a bare host state', bare == ['title'] * len(canvas) and 'LT_ScrollLabel' not in bare_xml, str(bare))
    ids = re.findall(r'<(?:container|component|layoutGroup) id="(\d+)"', xml)
    failed += check(app_id + ': ID8 component ids are unique', len(ids) == len(set(ids)))
    # the manifest for MainApp-21: both HMI interface generations, Certification, none of the iDrive 7 only ones
    m = build.manifest_for(json.loads(json.dumps(spec)), 'ID8')
    px = m['proxies']
    need = ['certification.Certification', 'hmi.entrypoint2.EntryPoint2', 'hmi.entrypoint2.EntryPointManager2', 'hmi.remote2.RemoteHmi2',
            'hmi.remote2.RemoteHmiApplication2', 'hmi.resourcemanagement2.ResourceBundle2', 'hmi.resourcemanagement2.ResourceManager2',
            'hmi.resourcemanagement2.StringBundle2', 'hmi.hmicontext2.HMIContext2', 'hmi.entrypoint.EntryPoint', 'hmi.remote.RemoteHmiApplication',
            'telematic.oap.PrivateEntryPoint2']
    missing = [n for n in need if 'de.bmw.infotainment.' + n not in px]
    failed += check(app_id + ': ID8 manifest has both HMI interface generations', not missing, str(missing))
    only7 = [k for k in px if re.search(r'lifecycle\.Lifecycle|personalization\.UserAccount$|PrivacySettings', k)] + [k for k in m['services'] if 'TriggersControl' in k]
    failed += check(app_id + ': ID8 manifest names no iDrive 7 only interface', not only7, str(only7))
    failed += check(app_id + ': ID8 manifest takes the app\'s interfaces whole', all(px.get(i) == '*' for i in spec.get('signals', {})), str({i: px.get(i) for i in spec.get('signals', {})}))
    failed += check(app_id + ': the ID7 manifest is the default', build.manifest_for(json.loads(json.dumps(spec))) == build.manifest_for(json.loads(json.dumps(spec)), 'ID7'))
    # the ACL tables: the rows iDrive 8 packages carry, and the tables MainApp-21 expects
    acl = json.load(open(os.path.join(build.KIT, 'platform', 'permissions.id8.json'), encoding='utf-8'))
    rows = [r['interfaceName'].split('/')[-1] for r in acl['masterAccessTable']]
    failed += check('permissions.id8.json has the iDrive 8 rows', all(n in rows for n in ('EntryPointManager2', 'ResourceManager2', 'StringBundle2', 'AppStart', 'PrivateEntryPoint')), str(rows))
    failed += check('permissions.id8.json has every table', sorted(acl) == sorted(json.load(open(os.path.join(build.KIT, 'platform', 'permissions.json'), encoding='utf-8'))))
    # the build target
    failed += check('target: --hmi wins', build.target_hmi('ID8')[0] == 'ID8' and build.target_hmi('ID7')[0] == 'ID7')
    d = tempfile.mkdtemp()
    try:
        on_unit = os.path.isdir('/usr/lib/oap-mainapp') or os.path.isdir('/usr/lib/oap-mainapp21')
        for ver, want in (('50.2.1', 'ID8'), ('24.10.2', 'ID7'), ('27.0.0', 'ID7')):
            json.dump({'version': ver}, open(os.path.join(d, 'package.json'), 'w'))
            got = build.target_hmi(None, d)[0]
            failed += check('target: oap-sdk %s is %s' % (ver, want), on_unit or got == want, got)
        failed += check('target: no head unit and no SDK is ID7', on_unit or build.target_hmi(None, os.path.join(d, 'none'))[0] == 'ID7')
    finally:
        shutil.rmtree(d, ignore_errors=True)
    return failed


def packages(app_id):
    """A whole build for each head unit, with a stand-in oap-sdk (skipped where a real one is extracted, so it is
    never touched): what goes into the package - both UI descriptions, the manifest and ACL tables of the target."""
    import glob, shutil, contextlib, io
    if os.path.exists(build.SDK):
        print('skip  %s: package contents (a real oap-sdk/ is here; not replaced by the stand-in)' % app_id)
        return 0
    failed = 0
    stage = os.path.join(build.DIST, app_id, 'source')
    load = lambda *p: json.load(open(os.path.join(stage, *p), encoding='utf-8'))
    try:
        for hmi, ver in (('ID7', '24.10.2'), ('ID8', '50.2.1')):
            os.makedirs(build.SDK, exist_ok=True)
            open(os.path.join(build.SDK, 'index.js'), 'w').write('module.exports = {};\n')
            json.dump({'name': 'oap-sdk', 'version': ver}, open(os.path.join(build.SDK, 'package.json'), 'w'))
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                build.build(app_id, hmi=hmi)
            failed += check('%s %s package: the build says its target' % (app_id, hmi), 'build target: %s (--hmi, oap-sdk %s)' % (hmi, ver) in out.getvalue(), out.getvalue())
            app = load('rhmiData', 'application.json')['application']
            failed += check('%s %s package: a UI description for each head unit' % (app_id, hmi),
                            [d['hmi'] for d in app['uiDescriptions']] == [['ID7'], ['ID8']] and app['variantGroups'][0]['hmi'] == ['ID7', 'ID8'])
            for d in app['uiDescriptions']:
                for k in ('applicationFilePath', 'uiDescriptionFilePath'):
                    failed += check('%s %s package: %s is there' % (app_id, hmi, d[k]), os.path.isfile(os.path.join(stage, 'rhmiData', d[k])))
            snap = open(os.path.join(SNAP, app_id, 'ID7.application.xml'), encoding='utf-8').read()
            failed += check('%s %s package: the ID7 description is the snapshot' % (app_id, hmi),
                            open(os.path.join(stage, 'rhmiData', 'uiDescriptions', 'ID7', 'application.xml'), encoding='utf-8').read() == snap)
            failed += check('%s %s package: no appletId (the deploy tool picks one on iDrive 8)' % (app_id, hmi), 'appletId' not in app)
            ep = app['entryPoints'][0]
            failed += check('%s %s package: the entry point both units take' % (app_id, hmi),
                            (ep['insertionStateId'], ep['insertionFocusId'], ep['insertionMode']) == (20974, 2, 'INSERT_BELOW'))
            failed += check('%s %s package: ships the oap-sdk' % (app_id, hmi), load('node_modules', 'oap-sdk', 'package.json')['version'] == ver)
            pkg, man, acl, spec = load('package.json'), load('manifest.json'), load('permissions.json'), load('javascript', 'kit', 'app-spec.json')
            failed += check('%s %s package: app-spec.json says what it was built for' % (app_id, hmi), spec['build']['hmi'] == hmi and spec['build']['sdk'] == ver, str(spec['build']))
            rows = [r['interfaceName'].split('/')[-1] for r in acl['masterAccessTable']]
            if hmi == 'ID8':
                failed += check('%s ID8 package: mguLocalOnly and mguHmi' % app_id, pkg.get('mguLocalOnly') is True and pkg.get('mguHmi') == ['ID8'])
                failed += check('%s ID8 package: the iDrive 8 manifest and ACL tables' % app_id,
                                'de.bmw.infotainment.hmi.remote2.RemoteHmiApplication2' in man['proxies'] and 'EntryPointManager2' in rows)
            else:
                failed += check('%s ID7 package: package.json, manifest and ACL tables as before' % app_id,
                                'mguLocalOnly' not in pkg and 'mguHmi' not in pkg
                                and json.dumps(man, indent=2, sort_keys=True) + '\n' == open(os.path.join(SNAP, app_id, 'manifest.ID7.json'), encoding='utf-8').read()
                                and acl == json.load(open(os.path.join(build.KIT, 'platform', 'permissions.json'), encoding='utf-8')))
    finally:
        shutil.rmtree(build.SDK, ignore_errors=True)
        # (the archives hold the stand-in SDK: not installable, so they do not stay)
        for f in glob.glob(os.path.join(build.DIST, app_id + '@*')):
            os.remove(f)
    return failed


def main():
    write = '--write' in sys.argv
    failed = 0
    for app_id in APPS:
        d = os.path.join(SNAP, app_id)
        for name, text in id7(app_id).items():
            p = os.path.join(d, name)
            if write:
                os.makedirs(d, exist_ok=True)
                open(p, 'w', encoding='utf-8', newline='\n').write(text)
                print('wrote', os.path.relpath(p, build.ROOT))
            elif not os.path.exists(p) or open(p, encoding='utf-8').read() != text:
                failed += 1
                print('FAIL  %s: %s differs from the snapshot (iDrive 7 output changed)' % (app_id, name))
            else:
                print('ok    %s: %s as before' % (app_id, name))
    if not write:
        for app_id in APPS:
            failed += id8(app_id)
            failed += packages(app_id)
    if failed:
        sys.exit('%d check(s) failed' % failed)
    if not write:
        print('build: all ok')


if __name__ == '__main__':
    main()
