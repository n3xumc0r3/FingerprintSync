import sys

def fix_bg():
    with open('/home/z/my-project/FingerprintSync/background.js', 'r') as f:
        content = f.read()
    
    # 1. Replace signature (line 118)
    old_sig = 'async function applyAllDNRRules(uaString) {'
    new_sig = 'async function applyAllDNRRules(profile) {'
    content = content.replace(old_sig, new_sig, 1)
    
    
    # 2. Find line 164 (regex blocker comment)
    idx = content.find('// 3. Regex blocker rules (ID 100+)')
    if idx == -1:
        print('REGEX LINE NOT FOUND')
        sys.exit(1)
    
    # Build new content
    parts = content[:idx] + [new_sig] + content[idx+1:]
    
    insert = '''
    // 3b. Accept-Language (ID 3)
    langs = (profile.languages || [profile.language || 'en-US'])
    acceptLang = ",
    .join([
        l + ";q=" + (i == 0 ? "1.0" : (i == 1 ? "0.9" : "0.8")) + ",
    "
  );
    allRules.push({
      id: 3, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Accept-Language', operation: 'set', value: acceptLang }],
      condition: { urlFilter: '*://*/*', resourceTypes, ...(excludedInitiatorDomains ? { excludedInitiatorDomains } : {}) },
    });
    '''
    # 3. Find line with closing brace of function
    cb = content.rfind('}', idx + 1)
    if cb == -1:
        print('CLOSING BRACE NOT FOUND')
        sys.exit(1)
    parts = content[idx:cb+1]
    new_content = content[:idx] + [new_sig] + parts + '''
    # 4. DNT header removal (ID 4)
    allRules.push({
      id: 4, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'DNT', operation: 'remove' }] },
      condition: { urlFilter: '*://*/*', resourceTypes, ...(excludedInitiatorDomains ? { excludedInitiatorDomains } : {}) },
    });
    '''
    # 5. Low-entropy device/client hints (ID 5)
    allRules.push({
      id: 5, priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Sec-CH-Device-Memory', operation: 'set', value: String(profile.deviceMemory || 8) },
          { header: 'Sec-CH-DPR', operation: 'set', value: String(profile.screen.devicePixelRatio || '1') },
          { header: 'Sec-CH-Viewport-Width', operation: 'set', value: String(profile.screen.availWidth || '1920') },
          { header: 'Sec-CH-Viewport-Height', operation: 'set', value: String(profile.screen.availHeight || '1080') },
          { header: 'Sec-CH-Prefers-Color-Scheme', operation: 'set', value: 'light' },
          { header: 'Sec-CH-Prefers-Reduced-Motion', operation: 'set', value: 'no-preference' },
        ],
      },
      condition: { urlFilter: '*://*/*', resourceTypes, ...(excludedInitiatorDomains ? { excludedInitiatorDomains } : {}) },
    });
    '''
    with open('/home/z/my-project/FingerprintSync/background.js', 'w', encoding='utf-8', newline='\n') as fw:
        fw.write(content)
        print('DONE')
