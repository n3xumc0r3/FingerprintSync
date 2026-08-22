import sys

with open('/home/z/my-project/FingerprintSync/background.js', 'r') as f:
    old = f.read()
    # Find the function signature line
    sig_line = -1
    for i, line in enumerate(old.split(chr(10)):
        if 'async function applyAllDNRRules(uaString)' in line:
            sig_line = i
            break
    print(f'Signature at line {sig_line+1}')
    # Count braces to find function end
    bc = 0
    func_lines = []
    for j, line in enumerate(old.split(chr(10))[sig_line:], start=1):
        func_lines.append(line)
        if '{' in line: bc += 1
        elif '}' in line: bc -= 1
        if bc == 0:
            func_end_line = j + sig_line
            break
    print(f'Function body: lines {sig_line+2} to {func_end_line}')
    # Extract: header + signature + body (up to before // 3. Regex blocker)
    header = old.split(chr(10))[:sig_line]
    rest = old.split(chr(10))[sig_line+1:func_end_line]
    chromever_line = rest.find('\n    const chromeVer = (profile.ua.match(/Chrome/)    const chromeVer = (profile.ua.match(/Chrome    const chromeVer = (uaString.match(/Chrome    const chromeVer = (uaString.match(/Chrome')
') if chromever_line >= 0 else -1
    print(f'chromeVer line: {chromever_line}')

    # Build new function body: keep from signature to end of chromeVer line,
    # then regex blocker section, then insert new rules before it
    regex_section = rest[chromever_line:]
    # The new rules to insert before regex
    insert_rules = '''
    // 3b. Accept-Language (ID 3)
    const langs = profile.languages || [profile.language || 'en-US'];
    const acceptLang = langs.map((l, i) => {
      const q = i === 0 ? '1.0' : (i === 1 ? '0.9' : '0.8');
      return l + ';q=' + q;
    }).join(', ');
    allRules.push({
      id: 3, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Accept-Language', operation: 'set', value: acceptLang }] },
      condition: { urlFilter: '*://*/*', resourceTypes, ...(excludedInitiatorDomains ? { excludedInitiatorDomains } : {}) },
    });

    // 4. DNT header removal (ID 4)
    allRules.push({
      id: 4, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'DNT', operation: 'remove' }] },
      condition: { urlFilter: '*://*/*', resourceTypes, ...(excludedInitiatorDomains ? { excludedInitiatorDomains } : {}) },
    });

    // 5. Low-entropy device/client hints (ID 5)
    const devMem = profile.deviceMemory || 8;
    const dpr = (profile.screen && profile.screen.devicePixelRatio) ? String(profile.screen.devicePixelRatio) : '1';
    const vw = (profile.screen && profile.screen.availWidth) ? String(profile.screen.availWidth) : '1920';
    const vh = (profile.screen && profile.screen.availHeight) ? String(profile.screen.availHeight) : '1080';
    allRules.push({
      id: 5, priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Sec-CH-Device-Memory', operation: 'set', value: String(devMem) },
          { header: 'Sec-CH-DPR', operation: 'set', value: dpr },
          { header: 'Sec-CH-Viewport-Width', operation: 'set', value: vw },
          { header: 'Sec-CH-Viewport-Height', operation: 'set', value: vh },
          { header: 'Sec-CH-Prefers-Color-Scheme', operation: 'set', value: 'light' },
          { header: 'Sec-CH-Prefers-Reduced-Motion', operation: 'set', value: 'no-preference' },
        ],
      },
      condition: { urlFilter: '*://*/*', resourceTypes, ...(excludedInitiatorDomains ? { excludedInitiatorDomains } : {}) },
    });
'''
    new_body = header + chr(10) + '''async function applyAllDNRRules(profile) {
      const chromeVer = (profile.ua.match(/Chrome/[\\d]+/) || ['','130'])[1];
''' + regex_section + insert_rules
    f.seek(0)
    f.write(new_body)
    print('DONE')
