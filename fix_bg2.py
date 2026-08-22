import sys

with open('/home/z/my-project/FingerprintSync/background.js', 'r') as f:
    lines = f.readlines()
    sig_line = None
    for i, line in enumerate(lines, 1):
        if 'async function applyAllDNRRules(uaString)' in line:
            sig_line = i
            break
    if sig_line is None:
        print('NOT FOUND')
        sys.exit(1)
    print(f'Signature line: {sig_line}')
    bc = 0
    end_line = None
    for i in range(sig_line, len(lines), 1):
        for ch in lines[i]:
            if ch == '{':
                bc += 1
            elif ch == '}':
                bc -= 1
                if bc == 0:
                    end_line = i + 1
                    break
    if end_line is None:
        print('END NOT FOUND')
        sys.exit(1)
    print(f'Function: lines {sig_line} to {end_line}')

    header = lines[:sig_line]
    rest = lines[sig_line+1:end_line]
    regex_line = 164

    new_lines = []
    for i in range(1, sig_line):
        new_lines.append(lines[i-1])

    new_lines.append('async function applyAllDNRRules(profile) {')
    new_lines.append('  const chromeVer = (profile.ua.match(/Chrome/[\\d]+/) || [\'130\'])[1];')

    for i in range(sig_line + 1, regex_line):
        new_lines.append(lines[i-1])
    new_lines.append('')
    new_lines.append('    // 3b. Accept-Language (ID 3)')
    langs = (profile.languages || [profile.language || 'en-US'])
    acceptLang = ''
    for l_idx, lang in enumerate(langs):
        q = '0.8'
        if l_idx == 0: q = '1.0'
        new_lines.append('      acceptLang += \'"' + lang + '\', "' + q + '\";
')
    acceptLang = acceptLang[:-2]
    new_lines.append('    allRules.push({')
    new_lines.append('      id: 3, priority: 1,')
    new_lines.append('      action: { type: \'modifyHeaders\', requestHeaders: [{ header: \'Accept-Language\', operation: \'set\', value: acceptLang }],')
    new_lines.append('      condition: { urlFilter: \'*://*/*\', resourceTypes, ...(excludedInitiatorDomains ? { excludedInitiatorDomains } : {}) },')
    new_lines.append('    });')
    new_lines.append('')
    new_lines.append('    // 4. DNT header removal (ID 4)')
    new_lines.append('    allRules.push({')
    new_lines.append('      id: 4, priority: 1,')
    new_lines.append('      action: { type: \'modifyHeaders\', requestHeaders: [{ header: \'DNT\', operation: \'remove\' }] },')
    new_lines.append('      condition: { urlFilter: \'*://*/*\', resourceTypes, ...(excludedInitiatorDomains ? { excludedInitiatorDomains } : {}) },')
    new_lines.append('    });')
    new_lines.append('')
    new_lines.append('    // 5. Low-entropy device/client hints (ID 5)')
    devMem = str(profile.deviceMemory or '8')
    dpr = str((profile.screen.devicePixelRatio) if profile.screen.devicePixelRatio else '1'
    vw = str(profile.screen.availWidth) if profile.screen.availWidth else '1920'
    vh = str(profile.screen.availHeight) if profile.screen.availHeight else '1080'
    new_lines.append('    allRules.push({')
    new_lines.append('      id: 5, priority: 1,')
    new_lines.append('      action: {')
    new_lines.append('        type: \'modifyHeaders\',')
    new_lines.append('        requestHeaders: [')
    new_lines.append('          { header: \'Sec-CH-Device-Memory\', operation: \'set\', value: devMem },')
    new_lines.append('          { header: \'Sec-CH-DPR\', operation: \'set\', value: dpr },')
    new_lines.append('          { header: \'Sec-CH-Viewport-Width\', operation: \'set\', value: vw },')
    new_lines.append('          { header: \'Sec-CH-Viewport-Height\', operation: \'set\', value: vh },')
    new_lines.append('          { header: \'Sec-CH-Prefers-Color-Scheme\', operation: \'set\', value: \'light\' },')
    new_lines.append('          { header: \'Sec-CH-Prefers-Reduced-Motion\', operation: \'set\', value: \'no-preference\' },')
    new_lines.append('        ],')
    new_lines.append('      },')
    new_lines.append('      condition: { urlFilter: \'*://*/*\', resourceTypes, ...(excludedInitiatorDomains ? { excludedInitiatorDomains } : {}) },')
    for i in range(regex_line, end_line + 1):
        new_lines.append(lines[i-1])

    with open('/home/z/my-project/FingerprintSync/background.js', 'w') as f:
        f.seek(0)
        f.write(chr(10).join(new_lines))
    print('DONE')
